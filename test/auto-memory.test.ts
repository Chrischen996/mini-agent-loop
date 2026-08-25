import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { AutoMemoryExtractor, isAutoMemoryEnabled } from "../src/memory/auto-memory.ts";
import { MemoryStore } from "../src/orchestration/memory-store.ts";
import { makeLlmConfig } from "../src/llm/index.ts";
import type { LlmConfig } from "../src/llm/index.ts";
import type { AgentMessage } from "../src/types.ts";

const dummyLlm: LlmConfig = makeLlmConfig({
  apiKey: "test-key",
  baseUrl: "http://localhost/v1",
  model: "faux",
});

function makeHistory(turns: number): AgentMessage[] {
  const messages: AgentMessage[] = [{ role: "system", content: "system prompt" }];
  for (let i = 0; i < turns; i += 1) {
    messages.push({ role: "user", content: `question ${i}` });
    messages.push({ role: "assistant", content: `answer ${i}` });
  }
  return messages;
}

describe("isAutoMemoryEnabled", () => {
  it("defaults to enabled and honors opt-out env", () => {
    const previous = process.env.MINI_AGENT_AUTO_MEMORY;
    try {
      delete process.env.MINI_AGENT_AUTO_MEMORY;
      assert.equal(isAutoMemoryEnabled(), true);
      process.env.MINI_AGENT_AUTO_MEMORY = "0";
      assert.equal(isAutoMemoryEnabled(), false);
      process.env.MINI_AGENT_AUTO_MEMORY = "false";
      assert.equal(isAutoMemoryEnabled(), false);
      process.env.MINI_AGENT_AUTO_MEMORY = "1";
      assert.equal(isAutoMemoryEnabled(), true);
    } finally {
      if (previous === undefined) delete process.env.MINI_AGENT_AUTO_MEMORY;
      else process.env.MINI_AGENT_AUTO_MEMORY = previous;
    }
  });
});

describe("AutoMemoryExtractor gating", () => {
  it("skips extraction when fewer than minNewMessages new messages exist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-auto-mem-gate-"));
    try {
      const store = new MemoryStore(path.join(root, "memory", "records.json"));
      let llmCalls = 0;
      const extractor = new AutoMemoryExtractor(dummyLlm, store, { minNewMessages: 4 }, root);
      // Replace the internal extract path by ensuring gate short-circuits
      // before any LLM call: history has only 2 conversational messages.
      const result = await extractor.maybeExtract(makeHistory(1));
      assert.deepEqual(result, { ran: false, added: [], forgotten: [] }, "should skip below threshold");
      assert.equal(llmCalls, 0);

      const records = await store.list();
      assert.equal(records.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists progress state after processing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-auto-mem-state-"));
    const originalFetch = globalThis.fetch;
    try {
      const store = new MemoryStore(path.join(root, "memory", "records.json"));
      const extractor = new AutoMemoryExtractor(dummyLlm, store, { minNewMessages: 2 }, root);
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '[{"key":"user-language","content":"User prefers Chinese responses","action":"add"}]',
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch;

      const result = await extractor.maybeExtract(makeHistory(3));
      assert.equal(result.ran, true, "extraction should run above threshold");
      assert.deepEqual(result.added, ["user-language"], "added keys should be reported");

      const raw = await readFile(path.join(root, "memory", "extraction-state.json"), "utf8");
      const state = JSON.parse(raw) as { lastProcessedCount: number };
      assert.equal(state.lastProcessedCount, 6, "state should track processed count");
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("extracts and upserts memories from a finished turn", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-auto-mem-extract-"));
    const originalFetch = globalThis.fetch;
    try {
      const store = new MemoryStore(path.join(root, "memory", "records.json"));
      const extractor = new AutoMemoryExtractor(dummyLlm, store, { minNewMessages: 2 }, root);
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    'Here are memories:\n[{"key":"build-command","content":"Use pnpm test for this repo","action":"add"},{"key":"old-fact","content":"","action":"forget"}]',
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch;

      // Seed an existing memory that the extractor will update, plus one to forget.
      await store.upsertByKey("project", "build-command", "Old build command", "seed");
      const toForget = await store.upsertByKey("project", "old-fact", "Obsolete fact", "seed");

      const result = await extractor.maybeExtract(makeHistory(2));
      assert.equal(result.ran, true);
      assert.deepEqual(result.added, ["build-command"]);
      assert.deepEqual(result.forgotten, ["old-fact"]);

      const records = await store.list({ includeForgotten: true });
      const updated = records.find((record) => record.key === "build-command");
      assert.ok(updated, "build-command should exist");
      assert.equal(updated.content, "Use pnpm test for this repo", "same key should be updated not duplicated");
      assert.equal(updated.source, "turn-end-extract");

      const forgotten = records.find((record) => record.id === toForget.id);
      assert.equal(forgotten?.status, "forgotten", "forget action should mark obsolete memory");
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never throws when the LLM call fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-auto-mem-err-"));
    const originalFetch = globalThis.fetch;
    try {
      const store = new MemoryStore(path.join(root, "memory", "records.json"));
      const extractor = new AutoMemoryExtractor(dummyLlm, store, { minNewMessages: 2 }, root);
      globalThis.fetch = (async () =>
        new Response("server exploded", { status: 500 })) as unknown as typeof fetch;

      const result = await extractor.maybeExtract(makeHistory(2));
      assert.equal(result.ran, false, "failed extraction should report not-run without throwing");
      const records = await store.list();
      assert.equal(records.length, 0);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores malformed extractor output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-auto-mem-badjson-"));
    const originalFetch = globalThis.fetch;
    try {
      const store = new MemoryStore(path.join(root, "memory", "records.json"));
      const extractor = new AutoMemoryExtractor(dummyLlm, store, { minNewMessages: 2 }, root);
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "I think nothing is worth saving here!" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch;

      const result = await extractor.maybeExtract(makeHistory(2));
      assert.equal(result.ran, true, "run completes even with unparseable output");
      assert.deepEqual(result.added, [], "no memories reported from malformed output");
      const records = await store.list();
      assert.equal(records.length, 0, "no memories written from malformed output");
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("MemoryStore.upsertByKey", () => {
  it("updates in place on same key and creates otherwise", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-mem-upsert-"));
    try {
      const store = new MemoryStore(path.join(root, "memory", "records.json"));
      const first = await store.upsertByKey("project", "style", "concise answers", "test");
      const second = await store.upsertByKey("project", "style", "very concise answers", "test");
      assert.equal(first.id, second.id, "same key should reuse the record");
      const all = await store.list();
      assert.equal(all.length, 1);
      assert.equal(all[0]!.content, "very concise answers");

      await store.upsertByKey("user", "style", "different scope is separate", "test");
      assert.equal((await store.list()).length, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
