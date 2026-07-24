import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeLlmConfig, streamChat } from "../src/llm/index.ts";
import type { AgentMessage } from "../src/types.ts";

function sseResponse(chunks: string[]): Response {
  const payload = chunks.map((chunk) => `data: ${chunk}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(payload, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("streamChat", () => {
  it("yields text deltas then a final assistant message", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "你" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "好" } }] }),
      ])) as typeof fetch;

    try {
      const config = makeLlmConfig({
        apiKey: "test-key",
        baseUrl: "http://localhost/v1",
        model: "gpt-4o-mini",
      });
      const messages: AgentMessage[] = [{ role: "user", content: "hi" }];
      const events = [];
      for await (const event of streamChat(config, messages)) {
        events.push(event);
      }
      assert.deepEqual(
        events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" ? event.text : ""),
        ["你", "好"],
      );
      const final = events.at(-1);
      assert.equal(final?.type, "assistant");
      if (final?.type === "assistant") {
        assert.equal(final.message.content, "你好");
        assert.equal(final.message.toolCalls, undefined);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("aggregates fragmented tool call arguments", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponse([
        JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_1",
                function: { name: "read", arguments: "" },
              }],
            },
          }],
        }),
        JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: '{"path":"a' },
              }],
            },
          }],
        }),
        JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: '.ts"}' },
              }],
            },
          }],
        }),
      ])) as typeof fetch;

    try {
      const config = makeLlmConfig({
        apiKey: "test-key",
        baseUrl: "http://localhost/v1",
        model: "deepseek-chat",
      });
      const events = [];
      for await (const event of streamChat(config, [{ role: "user", content: "read" }])) {
        events.push(event);
      }
      const final = events.at(-1);
      assert.equal(final?.type, "assistant");
      if (final?.type === "assistant") {
        assert.equal(final.message.content, "");
        assert.equal(final.message.toolCalls?.length, 1);
        assert.equal(final.message.toolCalls?.[0]?.name, "read");
        assert.deepEqual(final.message.toolCalls?.[0]?.arguments, { path: "a.ts" });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
