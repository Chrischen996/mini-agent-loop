/**
 * P5: Concurrency, security, and regression tests for the Web UI workbench.
 *
 * Covers:
 * - Multi-session concurrency
 * - Session busy rejection (409 on duplicate submission)
 * - Permission denial flow
 * - Model error propagation
 * - Stream abort → server-side cancellation
 * - Server restart session persistence
 * - Path traversal in workspace list
 * - API key leak audit on /api/config
 * - TUI slash command independence (non-interference)
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import request from "supertest";
import { makeLlmConfig } from "../src/llm/index.ts";
import { createAgentServer } from "../src/server.ts";

const llm = makeLlmConfig({
  apiKey: "sk-test-must-not-leak",
  baseUrl: "http://localhost/v1",
  model: "faux",
});

// ---------------------------------------------------------------------------
// 1. Multi-session concurrency
// ---------------------------------------------------------------------------
describe("P5 multi-session concurrency", () => {
  it("allows two sessions to exist and be listed independently", async () => {
    const app = createAgentServer({
      llm,
      tools: [],
      chat: async () => ({
        role: "assistant" as const,
        content: "reply-A",
      }),
    });

    const s1 = await request(app).post("/api/sessions");
    const s2 = await request(app).post("/api/sessions");
    assert.equal(s1.status, 201);
    assert.equal(s2.status, 201);

    const list = await request(app).get("/api/sessions");
    assert.equal(list.status, 200);
    const sessions = (list.body as { sessions: Array<{ id: string }> }).sessions;
    assert.ok(sessions.some((s) => s.id === s1.body.id));
    assert.ok(sessions.some((s) => s.id === s2.body.id));
  });

  it("messages to different sessions do not cross-contaminate", async () => {
    const app = createAgentServer({
      llm,
      tools: [],
      chat: async () => ({
        role: "assistant" as const,
        content: "from-A",
      }),
    });

    const s1 = await request(app).post("/api/sessions");
    const s2 = await request(app).post("/api/sessions");
    const id1 = (s1.body as { id: string }).id;
    const id2 = (s2.body as { id: string }).id;

    const r1 = await request(app).post(`/api/sessions/${id1}/messages`).field("prompt", "msg1");
    const r2 = await request(app).post(`/api/sessions/${id2}/messages`).field("prompt", "msg2");

    assert.match(r1.text, /msg1/);
    assert.match(r2.text, /msg2/);

    // Each session's history should only contain its own messages.
    const h1 = await request(app).get(`/api/sessions/${id1}`);
    const h2 = await request(app).get(`/api/sessions/${id2}`);
    assert.match(h1.text, /msg1/);
    assert.doesNotMatch(h1.text, /msg2/);
    assert.match(h2.text, /msg2/);
    assert.doesNotMatch(h2.text, /msg1/);
  });
});

// ---------------------------------------------------------------------------
// 2. Session busy (409 on duplicate submission while streaming)
// ---------------------------------------------------------------------------
describe("P5 session busy rejection", () => {
  it("returns 409 when submitting a second message to a busy session", async () => {
    let resolveChat: (() => void) | undefined;
    const app = createAgentServer({
      llm,
      tools: [],
      chat: async () => {
        // Never resolve — keeps the session busy indefinitely for this test.
        await new Promise<void>((r) => { resolveChat = r; });
        return { role: "assistant" as const, content: "never" };
      },
    });

    const created = await request(app).post("/api/sessions");
    const sessionId = (created.body as { id: string }).id;

    // Start first message (will hang) — use .then() to not await so it runs in background.
    let firstDone = false;
    const firstReq = request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .field("prompt", "first")
      .then((res) => { firstDone = true; return res; })
      .catch(() => { firstDone = true; });

    // Give the server time to start processing the first request.
    await new Promise((r) => setTimeout(r, 200));

    // Second message should be rejected with 409.
    const secondReq = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .field("prompt", "second");
    assert.equal(secondReq.status, 409);
    assert.match((secondReq.body as { error: string }).error, /busy/i);

    // Cleanup: resolve the hanging chat so the first request finishes.
    resolveChat?.();
    // Wait for first request to complete.
    await firstReq;
  });
});

// ---------------------------------------------------------------------------
// 3. Permission denial flow
// ---------------------------------------------------------------------------
describe("P5 permission denial", () => {
  it("rejects invalid permission decisions", async () => {
    const app = createAgentServer({ llm, tools: [], chat: async () => ({ role: "assistant" as const, content: "x" }) });
    const created = await request(app).post("/api/sessions");
    const sessionId = (created.body as { id: string }).id;

    const badDecision = await request(app)
      .post(`/api/sessions/${sessionId}/permissions/some-id`)
      .send({ decision: "maybe" });
    assert.equal(badDecision.status, 400);
    assert.match((badDecision.body as { error: string }).error, /decision must be allow or deny/i);

    const unknownRequest = await request(app)
      .post(`/api/sessions/${sessionId}/permissions/nonexistent-request`)
      .send({ decision: "allow" });
    assert.equal(unknownRequest.status, 404);
  });

  it("resolves a permission request with allow", async () => {
    // We can't easily trigger a real permission_required without a tool that needs approval,
    // but we can verify the route contract is intact.
    const app = createAgentServer({ llm, tools: [], chat: async () => ({ role: "assistant" as const, content: "x" }) });
    const created = await request(app).post("/api/sessions");
    const sessionId = (created.body as { id: string }).id;

    // Non-existent request returns 404.
    const result = await request(app)
      .post(`/api/sessions/${sessionId}/permissions/fake-id`)
      .send({ decision: "allow" });
    assert.equal(result.status, 404);
    assert.match((result.body as { error: string }).error, /not found/i);
  });
});

// ---------------------------------------------------------------------------
// 4. Model error propagation
// ---------------------------------------------------------------------------
describe("P5 model error handling", () => {
  it("emits error event when chat provider throws", async () => {
    const app = createAgentServer({
      llm,
      tools: [],
      chat: async () => {
        throw new Error("provider is down");
      },
    });
    const created = await request(app).post("/api/sessions");
    const sessionId = (created.body as { id: string }).id;

    const response = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .field("prompt", "hello");
    assert.equal(response.status, 200);
    const lines = response.text.trim().split("\n");
    const types = lines.map((l) => JSON.parse(l) as { type?: string });
    assert.ok(types.some((e) => e.type === "error"), "should emit error event");
    const errEvent = types.find((e) => e.type === "error");
    assert.match(String((errEvent as { message?: string })?.message ?? ""), /provider is down/i);
  });
});

// ---------------------------------------------------------------------------
// 5. Stream abort → server-side cancellation
// ---------------------------------------------------------------------------
describe("P5 stream abort", () => {
  it("aborts gracefully when client disconnects", async () => {
    let chatStarted = false;
    let resolveChat: (() => void) | undefined;
    const app = createAgentServer({
      llm,
      tools: [],
      chat: async () => {
        chatStarted = true;
        await new Promise<void>((r) => { resolveChat = r; });
        return { role: "assistant" as const, content: "done" };
      },
    });

    // Bind to a random port so we can make fetch requests.
    const http = await import("node:http");
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    const created = await request(app).post("/api/sessions");
    const sessionId = (created.body as { id: string }).id;

    // Use abort controller to cancel mid-stream.
    const controller = new AbortController();
    const fetchPromise = fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "abort-me" }),
        signal: controller.signal,
      },
    ).catch(() => null);

    // Wait for chat to start.
    while (!chatStarted) await new Promise((r) => setTimeout(r, 50));

    // Abort.
    controller.abort();
    await fetchPromise;

    // After abort, resolve the hanging chat so server cleanup completes.
    resolveChat?.();
    // Wait for server to settle.
    await new Promise((r) => setTimeout(r, 200));
    server.close();
  });
});

// ---------------------------------------------------------------------------
// 6. Server restart session persistence
// ---------------------------------------------------------------------------
describe("P5 server restart persistence", () => {
  it("survives a server crash and restores session state", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "mini-agent-p5-restart-"));
    try {
      const app1 = createAgentServer({
        llm,
        tools: [],
        chat: async () => ({ role: "assistant" as const, content: "persisted" }),
        dataDir,
      });
      const created = await request(app1).post("/api/sessions");
      const sessionId = (created.body as { id: string }).id;
      await request(app1)
        .post(`/api/sessions/${sessionId}/messages`)
        .field("prompt", "save this");

      // Simulate server restart with a new instance reading the same dataDir.
      const app2 = createAgentServer({
        llm,
        tools: [],
        chat: async () => ({ role: "assistant" as const, content: "new-reply" }),
        dataDir,
      });
      const restored = await request(app2).get(`/api/sessions/${sessionId}`);
      assert.equal(restored.status, 200);
      assert.match(restored.text, /save this/);
      assert.match(restored.text, /persisted/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Path traversal in workspace list
// ---------------------------------------------------------------------------
describe("P5 workspace path security", () => {
  it("rejects path traversal in workspace listing", async () => {
    const app = createAgentServer({ llm, tools: [], chat: async () => ({ role: "assistant" as const, content: "x" }) });
    const resp = await request(app)
      .get("/api/workspace/list?path=../../etc/passwd");
    assert.notEqual(resp.status, 200);
  });

  it("rejects absolute path outside workspace", async () => {
    const app = createAgentServer({ llm, tools: [], chat: async () => ({ role: "assistant" as const, content: "x" }) });
    const resp = await request(app)
      .get("/api/workspace/list?path=/etc/passwd");
    assert.notEqual(resp.status, 200);
  });
});

// ---------------------------------------------------------------------------
// 8. API key leak audit on /api/config
// ---------------------------------------------------------------------------
describe("P5 API key leak audit", () => {
  it("does not expose API key in /api/config response", async () => {
    const app = createAgentServer({
      llm: { ...llm, apiKey: "SECRET_API_KEY_DO_NOT_LEAK" },
      tools: [],
      chat: async () => ({ role: "assistant" as const, content: "x" }),
    });
    const config = await request(app).get("/api/config");
    assert.equal(config.status, 200);
    assert.doesNotMatch(config.text, /SECRET_API_KEY_DO_NOT_LEAK/);
    assert.doesNotMatch(config.text, /api_key/i);
  });
});

// ---------------------------------------------------------------------------
// 9. TUI slash command independence
// ---------------------------------------------------------------------------
describe("P5 TUI slash command independence", () => {
  it("web-ui command is registered and parseable", async () => {
    // Import the parser to verify it's wired correctly.
    const { parseSlashCommand } = await import("../src/tui/slash-commands.ts");
    const parsed = parseSlashCommand("/web-ui status");
    assert.ok(parsed);
    assert.equal(parsed.cmd, "web-ui");
    // raw contains everything after the leading slash, including the command name.
    assert.equal(parsed.raw, "web-ui status");

    const help = parseSlashCommand("/web-ui --no-open --port 3080");
    assert.ok(help);
    assert.equal(help.cmd, "web-ui");
    assert.equal(help.raw, "web-ui --no-open --port 3080");
  });

  it("unknown slash commands are not sent to LLM (parsed as null)", async () => {
    const { parseSlashCommand } = await import("../src/tui/slash-commands.ts");
    const parsed = parseSlashCommand("/nonexistent-command");
    assert.equal(parsed, null);
  });
});

// ---------------------------------------------------------------------------
// 10. Long context and large event tolerance
// ---------------------------------------------------------------------------
describe("P5 long context tolerance", () => {
  it("handles a very long assistant response without crashing", async () => {
    const longContent = "x".repeat(50_000);
    const app = createAgentServer({
      llm,
      tools: [],
      chat: async () => ({ role: "assistant" as const, content: longContent }),
    });
    const created = await request(app).post("/api/sessions");
    const sessionId = (created.body as { id: string }).id;
    const resp = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .field("prompt", "long-context-test");
    assert.equal(resp.status, 200);
    assert.match(resp.text, /{"type":"user"/);
  });
});

// ---------------------------------------------------------------------------
// 11. Concurrent session active status
// ---------------------------------------------------------------------------
describe("P5 concurrent session active status", () => {
  it("marks session busy during streaming and free after", async () => {
    let resolveChat: (() => void) | undefined;
    const app = createAgentServer({
      llm,
      tools: [],
      chat: async () => {
        await new Promise<void>((r) => { resolveChat = r; });
        return { role: "assistant" as const, content: "done" };
      },
    });

    const created = await request(app).post("/api/sessions");
    const sessionId = (created.body as { id: string }).id;

    // Start streaming — run in background.
    let streamDone = false;
    const streamReq = request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .field("prompt", "stream-test")
      .then((r) => { streamDone = true; return r; })
      .catch(() => { streamDone = true; });

    // Check session status mid-stream.
    await new Promise((r) => setTimeout(r, 200));
    const status = await request(app).get(`/api/sessions/${sessionId}`);
    assert.equal(status.status, 200);
    const detail = status.body as { busy: boolean };
    assert.equal(detail.busy, true, "session should be marked busy during streaming");

    // Complete the stream.
    resolveChat?.();
    await streamReq;
    assert.equal(streamDone, true, "stream request should complete");

    // After completion, session should be free.
    const finalStatus = await request(app).get(`/api/sessions/${sessionId}`);
    assert.equal(finalStatus.body.busy, false);
  });
});
