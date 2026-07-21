import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { contentAsString } from "../src/content.ts";
import { loadMcpConfig } from "../src/mcp/config.ts";
import { createMcpApprovalGate } from "../src/mcp/approval.ts";
import { createMcpToolName, createMcpTools, mcpResultToToolResult } from "../src/mcp/tool-adapter.ts";
import { McpRuntime, mergeToolSets } from "../src/mcp/runtime.ts";
import type {
  McpClientConnection,
  McpStdioServerConfig,
  McpToolDefinition,
} from "../src/mcp/types.ts";
import type { Tool } from "../src/tools/types.ts";

const fixture = path.resolve("test/fixtures/mcp-stdio-server.mjs");

function fixtureServer(overrides: Partial<McpStdioServerConfig> = {}): McpStdioServerConfig {
  return {
    id: "fixture",
    transport: "stdio",
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    enabled: true,
    required: true,
    reconnect: true,
    reconnectDelayMs: 20,
    maxReconnectDelayMs: 100,
    excludeTools: [],
    timeoutMs: 5_000,
    maxTools: 8,
    maxSchemaBytes: 100_000,
    maxResultBytes: 10_000,
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for MCP state change");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function changeableConnection(initialDefinitions: McpToolDefinition[]): McpClientConnection & {
  definitions: McpToolDefinition[];
  failList: boolean;
  emitToolsChanged(): void;
} {
  let toolsChanged: (() => void) | undefined;
  return {
    definitions: initialDefinitions,
    failList: false,
    listTools: async function () {
      if (this.failList) throw new Error("refresh unavailable");
      return this.definitions;
    },
    callTool: async () => ({ content: [] }),
    onToolsChanged: (listener) => {
      toolsChanged = listener;
      return () => {
        if (toolsChanged === listener) toolsChanged = undefined;
      };
    },
    emitToolsChanged: () => toolsChanged?.(),
    close: async () => undefined,
  };
}

describe("MCP config", () => {
  it("loads explicit stdio servers and resolves environment references", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-mcp-config-"));
    try {
      const file = path.join(root, "mcp.json");
      await writeFile(file, JSON.stringify({
        mcpServers: {
          demo: {
            command: "node",
            args: ["server.mjs"],
            cwd: ".",
            env: { TOKEN: "${DEMO_TOKEN}", MODE: "test" },
            includeTools: ["echo"],
            reconnectDelayMs: 250,
            maxReconnectDelayMs: 2000,
          },
        },
      }), "utf8");
      const loaded = await loadMcpConfig(file, root, { DEMO_TOKEN: "secret" });
      assert.equal(loaded.servers.length, 1);
      assert.deepEqual(loaded.servers[0]?.env, { TOKEN: "secret", MODE: "test" });
      assert.equal(loaded.servers[0]?.cwd, root);
      assert.deepEqual(loaded.servers[0]?.includeTools, ["echo"]);
      assert.equal(loaded.servers[0]?.reconnect, true);
      assert.equal(loaded.servers[0]?.reconnectDelayMs, 250);
      assert.equal(loaded.servers[0]?.maxReconnectDelayMs, 2_000);
      assert.equal(loaded.servers[0]?.maxSchemaBytes, 262_144);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsupported transports and missing referenced secrets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-mcp-invalid-"));
    try {
      const file = path.join(root, "mcp.json");
      await writeFile(file, JSON.stringify({
        mcpServers: { demo: { transport: "http", command: "ignored" } },
      }), "utf8");
      await assert.rejects(loadMcpConfig(file, root, {}), /unsupported transport/);
      await writeFile(file, JSON.stringify({
        mcpServers: { demo: { command: "node", env: { TOKEN: "${MISSING}" } } },
      }), "utf8");
      await assert.rejects(loadMcpConfig(file, root, {}), /requires environment variable MISSING/);
      await writeFile(file, JSON.stringify({
        mcpServers: {
          demo: { command: "node", reconnectDelayMs: 100, maxReconnectDelayMs: 10 },
        },
      }), "utf8");
      await assert.rejects(loadMcpConfig(file, root, {}), /greater than or equal/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("MCP tool adapter", () => {
  it("creates provider-safe stable names and maps rich results", () => {
    const used = new Set<string>();
    const first = createMcpToolName("demo server", "read/file", used);
    assert.match(first, /^[A-Za-z0-9_-]+$/);
    assert.ok(first.length <= 64);
    const long = createMcpToolName("demo", "x".repeat(100), used);
    assert.ok(long.length <= 64);
    const result = mcpResultToToolResult({
      content: [
        { type: "text", text: "hello" },
        { type: "resource_link", uri: "https://example.test/doc", name: "doc" },
      ],
      structuredContent: { ok: true },
    }, 10_000);
    assert.match(contentAsString(result.content), /hello/);
    assert.match(contentAsString(result.content), /https:\/\/example\.test\/doc/);
    assert.match(contentAsString(result.content), /"ok": true/);
  });

  it("rejects oversized results without returning partial data", () => {
    const result = mcpResultToToolResult({
      content: [{ type: "text", text: "x".repeat(100) }],
    }, 20);
    assert.equal(result.isError, true);
    assert.match(contentAsString(result.content), /exceeded/);
  });

  it("keeps assigned tool names stable when a refreshed catalog adds a collision", () => {
    const assigned = new Map<string, string>();
    const client: McpClientConnection = {
      listTools: async () => [],
      callTool: async () => ({ content: [] }),
      close: async () => undefined,
    };
    const config = fixtureServer({ id: "demo" });
    const first = createMcpTools(config, client, [{
      name: "read/file",
      inputSchema: { type: "object" },
    }], new Set(), assigned).tools[0];
    const refreshed = createMcpTools(config, client, [
      { name: "read file", inputSchema: { type: "object" } },
      { name: "read/file", inputSchema: { type: "object" } },
    ], new Set(), assigned).tools;
    const existing = refreshed.find((tool) =>
      tool.source?.kind === "mcp" && tool.source.toolName === "read/file");
    assert.equal(existing?.name, first?.name);
    assert.notEqual(refreshed[0]?.name, existing?.name);
  });
});

describe("MCP approval gate", () => {
  const remoteTool: Tool = {
    name: "mcp__demo__write",
    description: "remote write",
    parameters: { type: "object" },
    source: { kind: "mcp", serverId: "demo", toolName: "write" },
    execute: async () => ({ content: "ok" }),
  };

  it("denies remote calls unless the client explicitly opts in", async () => {
    const deny = createMcpApprovalGate({ allow: false, approvalHint: "Use the explicit flag." });
    await assert.rejects(deny(remoteTool, {}), /requires explicit approval.*explicit flag/);
    const allow = createMcpApprovalGate({ allow: true, approvalHint: "unused" });
    await allow(remoteTool, {});
    await deny({ ...remoteTool, source: { kind: "local" } }, {});
  });
});

describe("MCP runtime", () => {
  it("connects to a real stdio server, paginates tools, and calls them", async () => {
    const loaded = {
      path: "inline",
      servers: [fixtureServer()],
    };
    const runtime = await McpRuntime.create(loaded);
    try {
      const tools = runtime.snapshot();
      assert.deepEqual(
        tools.map((tool) => tool.source?.kind === "mcp" && tool.source.toolName),
        ["echo", "delay", "refresh-tools", "shutdown"],
      );
      assert.equal(runtime.statuses()[0]?.state, "ready");
      assert.match(runtime.statuses()[0]?.warning ?? "", /background-task/);
      const echo = tools.find((tool) => tool.source?.kind === "mcp" && tool.source.toolName === "echo");
      assert.ok(echo);
      const result = await echo.execute({ text: "hello" });
      assert.match(contentAsString(result.content), /echo:hello/);
      assert.match(contentAsString(result.content), /"echoed": "hello"/);
    } finally {
      await runtime.close();
    }
    assert.equal(runtime.statuses()[0]?.state, "closed");
  });

  it("propagates cancellation to an in-flight MCP call", async () => {
    const runtime = await McpRuntime.create({
      path: "inline",
      servers: [fixtureServer()],
    });
    try {
      const delay = runtime.snapshot().find((tool) => tool.source?.kind === "mcp" && tool.source.toolName === "delay");
      assert.ok(delay);
      const controller = new AbortController();
      const pending = delay.execute({ milliseconds: 2_000 }, controller.signal);
      setTimeout(() => controller.abort(), 20);
      await assert.rejects(pending);
    } finally {
      await runtime.close();
    }
  });

  it("refreshes the live registry after tools/list_changed", async () => {
    const runtime = await McpRuntime.create({ path: "inline", servers: [fixtureServer()] });
    const localTool: Tool = {
      name: "local",
      description: "local",
      parameters: { type: "object" },
      execute: async () => ({ content: "local" }),
    };
    const tools = runtime.toolProvider([localTool]);
    try {
      const refresh = tools().find((tool) =>
        tool.source?.kind === "mcp" && tool.source.toolName === "refresh-tools");
      assert.ok(refresh);
      await refresh.execute({});
      await waitFor(() => tools().some((tool) =>
        tool.source?.kind === "mcp" && tool.source.toolName === "echo-v2"));
      assert.ok(tools().some((tool) => tool.name === "local"));
      assert.ok(!tools().some((tool) =>
        tool.source?.kind === "mcp" && tool.source.toolName === "echo"));
      assert.equal(runtime.statuses()[0]?.toolCount, 4);
    } finally {
      await runtime.close();
    }
  });

  it("removes stale tools and reconnects after the stdio server exits", async () => {
    const runtime = await McpRuntime.create({
      path: "inline",
      servers: [fixtureServer({ reconnectDelayMs: 50, maxReconnectDelayMs: 50 })],
    });
    try {
      const before = runtime.snapshot().find((tool) =>
        tool.source?.kind === "mcp" && tool.source.toolName === "echo");
      const shutdown = runtime.snapshot().find((tool) =>
        tool.source?.kind === "mcp" && tool.source.toolName === "shutdown");
      assert.ok(before);
      assert.ok(shutdown);
      await shutdown.execute({});
      await waitFor(() => runtime.statuses()[0]?.state === "reconnecting");
      assert.deepEqual(runtime.snapshot(), []);
      await waitFor(() => runtime.statuses()[0]?.state === "ready");
      const after = runtime.snapshot().find((tool) =>
        tool.source?.kind === "mcp" && tool.source.toolName === "echo");
      assert.ok(after);
      assert.notEqual(after, before);
      assert.equal(runtime.statuses()[0]?.reconnectAttempt, 1);
      await waitFor(() => runtime.statuses()[0]?.reconnectAttempt === undefined, 1_500);
    } finally {
      await runtime.close();
    }
  });

  it("recovers an optional server that is unavailable during startup", async () => {
    let attempts = 0;
    const connection: McpClientConnection = {
      listTools: async () => [{ name: "recovered", inputSchema: { type: "object" } }],
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      close: async () => undefined,
    };
    const runtime = await McpRuntime.create({
      path: "inline",
      servers: [fixtureServer({
        id: "optional",
        required: false,
        reconnectDelayMs: 5,
        maxReconnectDelayMs: 5,
      })],
    }, {
      clientFactory: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporarily offline");
        return connection;
      },
    });
    try {
      assert.equal(runtime.statuses()[0]?.state, "reconnecting");
      await waitFor(() => runtime.statuses()[0]?.state === "ready");
      assert.equal(attempts, 2);
      assert.equal(runtime.snapshot()[0]?.source?.kind, "mcp");
    } finally {
      await runtime.close();
    }
  });

  it("cancels a pending reconnect when the runtime closes", async () => {
    let attempts = 0;
    let reconnectAborted = false;
    const runtime = await McpRuntime.create({
      path: "inline",
      servers: [fixtureServer({
        id: "optional",
        required: false,
        reconnectDelayMs: 5,
        maxReconnectDelayMs: 5,
      })],
    }, {
      clientFactory: async (_config, signal) => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporarily offline");
        return await new Promise<McpClientConnection>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reconnectAborted = true;
            reject(Object.assign(new Error("Operation aborted"), { name: "AbortError" }));
          }, { once: true });
        });
      },
    });
    await waitFor(() => attempts === 2);
    await runtime.close();
    await waitFor(() => reconnectAborted);
    assert.equal(runtime.statuses()[0]?.state, "closed");
  });

  it("increases reconnect backoff while a server keeps flapping", async () => {
    const attempts: number[] = [];
    const runtime = await McpRuntime.create({
      path: "inline",
      servers: [fixtureServer({
        id: "flapping",
        required: false,
        reconnectDelayMs: 10,
        maxReconnectDelayMs: 80,
      })],
    }, {
      clientFactory: async () => {
        attempts.push(Date.now());
        let closeListener: ((error?: Error) => void) | undefined;
        let timer: NodeJS.Timeout | undefined;
        return {
          listTools: async () => [{ name: "ping", inputSchema: { type: "object" } }],
          callTool: async () => ({ content: [] }),
          onClose: (listener) => {
            closeListener = listener;
            timer = setTimeout(() => closeListener?.(new Error("flapping")), 1);
            return () => {
              closeListener = undefined;
              if (timer) clearTimeout(timer);
            };
          },
          close: async () => {
            closeListener = undefined;
            if (timer) clearTimeout(timer);
          },
        };
      },
    });
    try {
      await waitFor(() => attempts.length >= 5);
      const intervals = attempts.slice(1, 5).map((time, index) => time - attempts[index]!);
      assert.ok(intervals[0]! >= 8, `first reconnect was too fast: ${intervals[0]}ms`);
      assert.ok(intervals[1]! >= 16, `second reconnect was too fast: ${intervals[1]}ms`);
      assert.ok(intervals[2]! >= 32, `third reconnect was too fast: ${intervals[2]}ms`);
      assert.ok(intervals[3]! >= 64, `fourth reconnect was too fast: ${intervals[3]}ms`);
    } finally {
      await runtime.close();
    }
  });

  it("waits for a late reconnect client to close before close resolves", async () => {
    let attempts = 0;
    let lateClientClosed = false;
    const lateClient: McpClientConnection = {
      listTools: async () => [{ name: "late", inputSchema: { type: "object" } }],
      callTool: async () => ({ content: [] }),
      close: async () => { lateClientClosed = true; },
    };
    const runtime = await McpRuntime.create({
      path: "inline",
      servers: [fixtureServer({
        id: "late",
        required: false,
        reconnectDelayMs: 5,
        maxReconnectDelayMs: 5,
      })],
    }, {
      clientFactory: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporarily offline");
        await new Promise((resolve) => setTimeout(resolve, 50));
        return lateClient;
      },
    });
    await waitFor(() => attempts === 2);
    const started = Date.now();
    await runtime.close();
    assert.ok(Date.now() - started >= 30);
    assert.equal(lateClientClosed, true);
  });

  it("does not call the client factory when the startup signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let factoryCalled = false;
    await assert.rejects(McpRuntime.create({
      path: "inline",
      servers: [fixtureServer()],
    }, {
      signal: controller.signal,
      clientFactory: async () => {
        factoryCalled = true;
        throw new Error("must not run");
      },
    }), /aborted/i);
    assert.equal(factoryCalled, false);
  });

  it("keeps refresh warnings isolated between servers", async () => {
    const first = changeableConnection([{ name: "first", inputSchema: { type: "object" } }]);
    const second = changeableConnection([{ name: "second", inputSchema: { type: "object" } }]);
    const runtime = await McpRuntime.create({
      path: "inline",
      servers: [
        fixtureServer({ id: "first", reconnect: false }),
        fixtureServer({ id: "second", reconnect: false }),
      ],
    }, {
      clientFactory: async (config) => config.id === "first" ? first : second,
    });
    try {
      first.failList = true;
      first.emitToolsChanged();
      await waitFor(() => Boolean(runtime.statuses()[0]?.warning?.includes("refresh unavailable")));
      second.definitions = [{ name: "second-v2", inputSchema: { type: "object" } }];
      second.emitToolsChanged();
      await waitFor(() => runtime.snapshot().some((tool) =>
        tool.source?.kind === "mcp" && tool.source.toolName === "second-v2"));
      assert.match(runtime.statuses()[0]?.warning ?? "", /refresh unavailable/);
    } finally {
      await runtime.close();
    }
  });

  it("degrades optional servers and fails required servers", async () => {
    const failingFactory = async (config: { env?: Record<string, string> }): Promise<McpClientConnection> => {
      throw new Error(`offline ${config.env?.TOKEN ?? ""}`.trim());
    };
    const optional = await McpRuntime.create({
      path: "inline",
      servers: [{
        id: "optional",
        transport: "stdio",
        command: "none",
        args: [],
        cwd: process.cwd(),
        enabled: true,
        required: false,
        reconnect: false,
        reconnectDelayMs: 10,
        maxReconnectDelayMs: 10,
        env: { TOKEN: "secret-value" },
        excludeTools: [],
        timeoutMs: 100,
        maxTools: 1,
        maxSchemaBytes: 100,
        maxResultBytes: 100,
      }],
    }, { clientFactory: failingFactory });
    assert.equal(optional.statuses()[0]?.state, "error");
    assert.equal(optional.statuses()[0]?.error, "offline [REDACTED]");
    assert.deepEqual(optional.snapshot(), []);
    await assert.rejects(McpRuntime.create({
      path: "inline",
      servers: [{
        id: "required",
        transport: "stdio",
        command: "none",
        args: [],
        cwd: process.cwd(),
        enabled: true,
        required: true,
        reconnect: false,
        reconnectDelayMs: 10,
        maxReconnectDelayMs: 10,
        excludeTools: [],
        timeoutMs: 100,
        maxTools: 1,
        maxSchemaBytes: 100,
        maxResultBytes: 100,
      }],
    }, { clientFactory: failingFactory }), /Required MCP server required failed: offline/);
  });

  it("detects collisions when local and dynamic tool sets are merged", () => {
    const tool: Tool = {
      name: "same",
      description: "same",
      parameters: { type: "object" },
      execute: async () => ({ content: "ok" }),
    };
    assert.throws(() => mergeToolSets([tool], [{ ...tool }]), /Duplicate tool name/);
  });
});
