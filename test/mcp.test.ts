import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { contentAsString } from "../src/content.ts";
import { loadMcpConfig } from "../src/mcp/config.ts";
import { createMcpApprovalGate } from "../src/mcp/approval.ts";
import { createMcpToolName, mcpResultToToolResult } from "../src/mcp/tool-adapter.ts";
import { McpRuntime, mergeToolSets } from "../src/mcp/runtime.ts";
import type { McpClientConnection } from "../src/mcp/types.ts";
import type { Tool } from "../src/tools/types.ts";

const fixture = path.resolve("test/fixtures/mcp-stdio-server.mjs");

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
          },
        },
      }), "utf8");
      const loaded = await loadMcpConfig(file, root, { DEMO_TOKEN: "secret" });
      assert.equal(loaded.servers.length, 1);
      assert.deepEqual(loaded.servers[0]?.env, { TOKEN: "secret", MODE: "test" });
      assert.equal(loaded.servers[0]?.cwd, root);
      assert.deepEqual(loaded.servers[0]?.includeTools, ["echo"]);
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
      servers: [{
        id: "fixture",
        transport: "stdio" as const,
        command: process.execPath,
        args: [fixture],
        cwd: process.cwd(),
        enabled: true,
        required: true,
        excludeTools: [],
        timeoutMs: 5_000,
        maxTools: 8,
        maxSchemaBytes: 100_000,
        maxResultBytes: 10_000,
      }],
    };
    const runtime = await McpRuntime.create(loaded);
    try {
      const tools = runtime.snapshot();
      assert.deepEqual(tools.map((tool) => tool.source?.kind === "mcp" && tool.source.toolName), ["echo", "delay"]);
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
      servers: [{
        id: "fixture",
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        cwd: process.cwd(),
        enabled: true,
        required: true,
        excludeTools: [],
        timeoutMs: 5_000,
        maxTools: 8,
        maxSchemaBytes: 100_000,
        maxResultBytes: 10_000,
      }],
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
