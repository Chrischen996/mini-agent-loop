import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { makeLlmConfig } from "../src/llm/index.ts";
import { createAgentServer } from "../src/server.ts";

const llm = makeLlmConfig({
  apiKey: "must-not-leak",
  baseUrl: "http://localhost/v1",
  model: "faux",
});

async function listen(app: ReturnType<typeof createAgentServer>): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>, decoder: TextDecoder, pending = ""):
  Promise<{ frame: string; pending: string }> {
  let buffer = pending;
  while (!buffer.includes("\n\n")) {
    const next = await reader.read();
    assert.equal(next.done, false);
    buffer += decoder.decode(next.value, { stream: true });
  }
  const separator = buffer.indexOf("\n\n");
  return { frame: buffer.slice(0, separator), pending: buffer.slice(separator + 2) };
}

describe("todo SSE API", () => {
  it("sends the current snapshot, web updates, and survives cancelled readers", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "mini-agent-server-todo-sse-"));
    const app = createAgentServer({ llm, tools: [], dataDir, chat: async () => ({ role: "assistant", content: "unused" }) });
    const { server, baseUrl } = await listen(app);
    try {
      const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
      const { id } = await created.json() as { id: string };
      const events = await fetch(`${baseUrl}/api/sessions/${id}/todos/events`);
      assert.equal(events.status, 200);
      assert.equal(events.headers.get("content-type"), "text/event-stream; charset=utf-8");
      assert.equal(events.headers.get("cache-control"), "no-cache, no-transform");
      assert.equal(events.headers.get("connection"), "keep-alive");

      const reader = events.body?.getReader();
      assert.ok(reader);
      const decoder = new TextDecoder();
      let pending = "";
      const initial = await readFrame(reader, decoder, pending);
      pending = initial.pending;
      assert.equal(initial.frame.startsWith("data: "), true);
      assert.deepEqual(JSON.parse(initial.frame.slice(6)), { todos: [], version: 0 });

      const todos = [{ id: "web", content: "Edit from web", status: "completed" }];
      const updated = await fetch(`${baseUrl}/api/sessions/${id}/todos`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ todos, version: 0 }),
      });
      assert.equal(updated.status, 200);

      const update = await readFrame(reader, decoder, pending);
      assert.match(update.frame, /^event: todo_updated\ndata: /);
      assert.deepEqual(JSON.parse(update.frame.split("\n")[1]!.slice(6)), {
        todos,
        version: 1,
        source: "web",
      });

      await reader.cancel();
      const afterCancel = await fetch(`${baseUrl}/api/sessions/${id}/todos`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ todos: [], version: 1 }),
      });
      assert.equal(afterCancel.status, 200);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
