import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStreamableHttpMcpClient } from "../src/mcp/client.ts";
import { DeepWikiClient, DEEPWIKI_TOOL_NAMES, loadDeepWikiConfigFromEnv } from "../src/codebase/deepwiki-client.ts";
import { DeepWikiProvider } from "../src/codebase/deepwiki-provider.ts";
import { RepositoryStore } from "../src/codebase/repository-store.ts";
import { createCodebaseRuntimeFromEnv } from "../src/codebase/runtime.ts";
import { createCodebaseTools } from "../src/codebase/tools.ts";
import type { McpCallResult, McpClientConnection, McpToolDefinition } from "../src/mcp/types.ts";
import type { ToolResult } from "../src/tools/types.ts";

function definitions(names: readonly string[] = DEEPWIKI_TOOL_NAMES): McpToolDefinition[] {
  return names.map((name) => ({ name, inputSchema: { type: "object" } }));
}

function fakeConnection(options: {
  names?: readonly string[];
  call?: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<McpCallResult>;
} = {}): McpClientConnection & { closed: boolean } {
  let closed = false;
  return {
    get closed() { return closed; },
    listTools: async () => definitions(options.names),
    callTool: options.call ?? (async (name, args) => ({
      content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }],
    })),
    close: async () => { closed = true; },
  };
}

function unwrap(result: ToolResult): string {
  return typeof result.content === "string"
    ? result.content
    : result.content.map((part) => part.type === "text" ? part.text : "").join("");
}

describe("DeepWiki configuration", () => {
  it("is disabled by default and accepts bounded overrides", () => {
    assert.deepEqual(loadDeepWikiConfigFromEnv({}), {
      enabled: false,
      timeoutMs: 30_000,
      maxResultBytes: 102_400,
    });
    assert.deepEqual(loadDeepWikiConfigFromEnv({
      DEEPWIKI_ENABLED: "1",
      DEEPWIKI_TIMEOUT_MS: "5000",
      DEEPWIKI_MAX_RESULT_BYTES: "2000",
    }), {
      enabled: true,
      timeoutMs: 5000,
      maxResultBytes: 2000,
    });
    assert.throws(() => loadDeepWikiConfigFromEnv({ DEEPWIKI_TIMEOUT_MS: "0" }), /between 1/);
  });

  it("creates an opt-in lazy runtime without connecting", async () => {
    const disabled = createCodebaseRuntimeFromEnv({ environment: {} });
    const enabled = createCodebaseRuntimeFromEnv({ environment: { DEEPWIKI_ENABLED: "1" } });
    try {
      assert.equal(disabled.deepWikiEnabled, false);
      assert.equal(disabled.semanticProvider, undefined);
      assert.equal(enabled.deepWikiEnabled, true);
      assert.ok(enabled.semanticProvider);
    } finally {
      await Promise.all([disabled.close(), enabled.close()]);
    }
  });
});

describe("DeepWikiClient", () => {
  it("uses the SDK Streamable HTTP transport without exposing a generic endpoint", async () => {
    const requests: string[] = [];
    const mockFetch: typeof fetch = async (_input, init) => {
      const payload = init?.body ? JSON.parse(String(init.body)) as { id?: number; method: string } : undefined;
      if (payload) requests.push(payload.method);
      const headers = { "content-type": "application/json", "mcp-session-id": "test-session" };
      if (payload?.method === "initialize") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "deepwiki-fixture", version: "1.0.0" },
          },
        }), { status: 200, headers });
      }
      if (payload?.method === "notifications/initialized") return new Response(null, { status: 202, headers });
      if (payload?.method === "tools/list") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { tools: definitions() } }), { status: 200, headers });
      }
      if (payload?.method === "tools/call") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { content: [{ type: "text", text: "fixture response" }] } }), { status: 200, headers });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload?.id, result: {} }), { status: 200, headers });
    };
    const connection = await createStreamableHttpMcpClient({
      url: new URL("https://mcp.deepwiki.com/mcp"),
      timeoutMs: 1000,
      fetch: mockFetch,
    });
    try {
      assert.equal((await connection.listTools()).length, 3);
      const result = await connection.callTool("ask_question", { repoName: "octo/project", question: "why?" });
      assert.equal(result.content[0]?.type, "text");
      assert.deepEqual(requests, ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    } finally {
      await connection.close();
    }
  });

  it("applies the configured timeout to Streamable HTTP requests", async () => {
    const headers = { "content-type": "application/json", "mcp-session-id": "timeout-session" };
    const mockFetch: typeof fetch = async (_input, init) => {
      const payload = init?.body ? JSON.parse(String(init.body)) as { id?: number; method: string } : undefined;
      if (payload?.method === "initialize") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "timeout-fixture", version: "1.0.0" },
          },
        }), { status: 200, headers });
      }
      if (payload?.method === "notifications/initialized") return new Response(null, { status: 202, headers });
      if (payload?.method === "tools/list") {
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(Object.assign(new Error("request aborted"), { name: "AbortError" }));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return new Response(null, { status: 200, headers });
    };
    const connection = await createStreamableHttpMcpClient({
      url: new URL("https://mcp.deepwiki.com/mcp"),
      timeoutMs: 20,
      fetch: mockFetch,
    });
    try {
      await assert.rejects(connection.listTools(), /timed out|aborted/i);
    } finally {
      await connection.close();
    }
  });

  it("connects lazily, validates tools, and reuses one connection", async () => {
    let connections = 0;
    const first = fakeConnection();
    const client = new DeepWikiClient({ timeoutMs: 1000, maxResultBytes: 1000 }, async () => {
      connections += 1;
      return first;
    });
    assert.equal(connections, 0);
    assert.equal(await client.call("read_wiki_structure", { repoName: "octo/project" }), "read_wiki_structure:{\"repoName\":\"octo/project\"}");
    assert.equal(await client.call("read_wiki_contents", { repoName: "octo/project" }), "read_wiki_contents:{\"repoName\":\"octo/project\"}");
    assert.equal(connections, 1);
    await client.close();
    assert.equal(first.closed, true);
  });

  it("rejects an incomplete tool catalog and closes the connection", async () => {
    const connection = fakeConnection({ names: ["ask_question"] });
    const client = new DeepWikiClient({ timeoutMs: 1000, maxResultBytes: 1000 }, async () => connection);
    await assert.rejects(client.call("ask_question", { repoName: "octo/project", question: "What is it?" }), /missing required tools/);
    assert.equal(connection.closed, true);
  });

  it("drops a failed connection so the next call reconnects", async () => {
    let connections = 0;
    const broken = fakeConnection({ call: async () => { throw new Error("network down"); } });
    const healthy = fakeConnection();
    const client = new DeepWikiClient({ timeoutMs: 1000, maxResultBytes: 1000 }, async () => {
      connections += 1;
      return connections === 1 ? broken : healthy;
    });
    await assert.rejects(client.call("ask_question", { repoName: "octo/project", question: "why?" }), /network down/);
    assert.equal(await client.call("ask_question", { repoName: "octo/project", question: "why?" }), "ask_question:{\"repoName\":\"octo/project\",\"question\":\"why?\"}");
    assert.equal(connections, 2);
    assert.equal(broken.closed, true);
    await client.close();
  });

  it("rejects oversized results and propagates cancellation", async () => {
    const client = new DeepWikiClient({ timeoutMs: 1000, maxResultBytes: 20 }, async () => fakeConnection({
      call: async (_name, _args, signal) => {
        if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
        return { content: [{ type: "text", text: "x".repeat(100) }] };
      },
    }));
    await assert.rejects(client.call("ask_question", { repoName: "octo/project", question: "x" }), /exceeded/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(client.call("ask_question", { repoName: "octo/project", question: "x" }, controller.signal), /aborted/i);
    await client.close();
  });
});

describe("DeepWikiProvider and codebase tool", () => {
  it("maps operations and returns generated evidence without a revision", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-deepwiki-provider-"));
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(source, "README"), "hello\n", "utf8");
    const { execFile } = await import("node:child_process");
    const runGit = (args: string[]) => new Promise<void>((resolve, reject) => execFile("git", args, { cwd: source }, (error) => error ? reject(error) : resolve()));
    await runGit(["init", "-q"]);
    await runGit(["config", "user.email", "test@example.com"]);
    await runGit(["config", "user.name", "Test"]);
    await runGit(["add", "."]);
    await runGit(["commit", "-qm", "initial"]);
    const store = new RepositoryStore({ rootDir: path.join(root, "cache"), cloneUrl: () => source });
    const handle = await store.open("octo/project");
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = new DeepWikiClient({ timeoutMs: 1000, maxResultBytes: 1000 }, async () => fakeConnection({
      call: async (name, args) => {
        calls.push({ name, args });
        return { content: [{ type: "text", text: `semantic:${name}` }] };
      },
    }));
    const provider = new DeepWikiProvider(store, client);
    try {
      const structure = await provider.explain(handle.handle, "structure");
      assert.deepEqual(structure, { provider: "deepwiki", repository: "octo/project", content: "semantic:read_wiki_structure", generated: true });
      await provider.explain(handle.handle, "question", "  How does it work?  ");
      assert.deepEqual(calls[1], { name: "ask_question", args: { repoName: "octo/project", question: "How does it work?" } });
      await assert.rejects(provider.explain(handle.handle, "question"), /question is required/);
      await assert.rejects(provider.explain("repo_unknown", "contents"), /Unknown codebase handle/);

      const failingProvider = {
        explain: async () => { throw new Error("service offline"); },
        close: async () => undefined,
      };
      const tools = createCodebaseTools(store, { semanticProvider: failingProvider });
      const explain = tools.find((tool) => tool.name === "codebase_explain");
      const read = tools.find((tool) => tool.name === "codebase_read");
      assert.ok(explain && read);
      const explainResult = await explain.execute({ handle: handle.handle, operation: "contents" });
      assert.equal(explainResult.isError, true);
      assert.match(unwrap(explainResult), /service offline/);
      const readResult = await read.execute({ handle: handle.handle, path: "README" });
      assert.equal(readResult.isError, undefined);
      assert.match(unwrap(readResult), /hello/);
    } finally {
      await provider.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns stable disabled and unavailable tool errors", async () => {
    const store = { get: () => { throw new Error("Unknown codebase handle"); } } as unknown as RepositoryStore;
    const disabled = createCodebaseTools(store).find((tool) => tool.name === "codebase_explain");
    assert.ok(disabled);
    const disabledResult = await disabled.execute({ handle: "repo_x", operation: "structure" });
    assert.equal(disabledResult.isError, true);
    assert.match(unwrap(disabledResult), /DEEPWIKI_ENABLED=1/);
  });
});
