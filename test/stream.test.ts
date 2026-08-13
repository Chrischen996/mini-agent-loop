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

function sseResponseWithoutDone(chunks: string[]): Response {
  const payload = chunks.map((chunk) => `data: ${chunk}\n\n`).join("");
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

  it("accepts a provider finish_reason even when [DONE] is omitted", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponseWithoutDone([
        JSON.stringify({ choices: [{ delta: { content: "ok" } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      ])) as typeof fetch;

    try {
      const config = makeLlmConfig({
        apiKey: "test-key",
        baseUrl: "http://localhost/v1",
        model: "gpt-4o-mini",
      });
      const events = [];
      for await (const event of streamChat(config, [{ role: "user", content: "hi" }])) {
        events.push(event);
      }
      const final = events.at(-1);
      assert.equal(final?.type, "assistant");
      if (final?.type === "assistant") assert.equal(final.message.content, "ok");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("recognizes a terminal assistant message without a finish marker", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponseWithoutDone([
        JSON.stringify({ choices: [{ message: { content: "terminal" } }] }),
      ])) as typeof fetch;

    try {
      const config = makeLlmConfig({
        apiKey: "test-key",
        baseUrl: "http://localhost/v1",
        model: "gpt-4o-mini",
      });
      const events = [];
      for await (const event of streamChat(config, [{ role: "user", content: "hi" }])) {
        events.push(event);
      }
      const final = events.at(-1);
      assert.equal(final?.type, "assistant");
      if (final?.type === "assistant") assert.equal(final.message.content, "terminal");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects an incomplete provider stream instead of returning a truncated answer", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponseWithoutDone([
        JSON.stringify({ choices: [{ delta: { content: "truncated" } }] }),
      ])) as typeof fetch;

    try {
      const config = makeLlmConfig({
        apiKey: "test-key",
        baseUrl: "http://localhost/v1",
        model: "gpt-4o-mini",
      });
      await assert.rejects(
        async () => {
          for await (const _event of streamChat(config, [{ role: "user", content: "hi" }])) {
            // Consume the stream to exercise the terminal check.
          }
        },
        /LLM stream ended before completion/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces max-token truncation instead of treating it as a complete answer", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponseWithoutDone([
        JSON.stringify({ choices: [{ delta: { content: "partial" } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }),
      ])) as typeof fetch;

    try {
      const config = makeLlmConfig({
        apiKey: "test-key",
        baseUrl: "http://localhost/v1",
        model: "gpt-4o-mini",
      });
      await assert.rejects(
        async () => {
          for await (const _event of streamChat(config, [{ role: "user", content: "hi" }])) {
            // Consume the stream to exercise finish_reason handling.
          }
        },
        /reached max_tokens/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts reasoning and content arrays from compatible gateways", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponse([
        JSON.stringify({ choices: [{ delta: { reasoning: "plan " } }] }),
        JSON.stringify({ choices: [{ delta: { content: [{ type: "text", text: "answer" }] } }] }),
      ])) as typeof fetch;

    try {
      const config = makeLlmConfig({
        apiKey: "test-key",
        baseUrl: "http://localhost/v1",
        model: "gpt-4o-mini",
      });
      const events = [];
      for await (const event of streamChat(config, [{ role: "user", content: "hi" }])) events.push(event);
      assert.deepEqual(
        events.filter((event) => event.type === "text_delta").map((event) => event.text),
        ["plan ", "answer"],
      );
      const final = events.at(-1);
      assert.equal(final?.type, "assistant");
      if (final?.type === "assistant") assert.equal(final.message.content, "answer");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not send unsupported reasoning_effort to xAI-compatible gateways", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "ok" } }] }),
      ]);
    }) as typeof fetch;

    try {
      const config = makeLlmConfig({
        apiKey: "test-key",
        baseUrl: "http://localhost/v1",
        model: "xai/grok-4.5",
        thinkingLevel: "high",
      });
      for await (const _event of streamChat(config, [{ role: "user", content: "hi" }])) {
        // Consume the stream to force request construction and completion.
      }
      assert.equal(requestBody?.reasoning_effort, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
