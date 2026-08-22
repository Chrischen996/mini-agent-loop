import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeLlmConfig, streamChat, OutputTruncatedError, LlmTimeoutError, IncompleteLlmResponseError } from "../src/llm/index.ts";
import type { AgentMessage, AssistantMessage } from "../src/types.ts";

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
        events.filter((event) => event.type === "answer_delta" || event.type === "reasoning_delta").map((event) => event.type === "answer_delta" || event.type === "reasoning_delta" ? event.text : ""),
        ["你", "好"],
      );
      const final = events.at(-1);
      assert.equal(final?.type, "completed");
      if (final?.type === "completed") {
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
      assert.equal(final?.type, "completed");
      if (final?.type === "completed") {
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
      assert.equal(final?.type, "completed");
      if (final?.type === "completed") assert.equal(final.message.content, "ok");
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
      assert.equal(final?.type, "completed");
      if (final?.type === "completed") assert.equal(final.message.content, "terminal");
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
      const events = [];
      for await (const event of streamChat(config, [{ role: "user", content: "hi" }])) {
        events.push(event);
      }
      // Should yield an error event for max_tokens truncation
      const errorEvent = events.find(e => e.type === "error");
      assert.ok(errorEvent);
      assert.ok(errorEvent?.error instanceof OutputTruncatedError);
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
        events.filter((event) => event.type === "answer_delta" || event.type === "reasoning_delta").map((event) => event.text),
        ["plan ", "answer"],
      );
      const final = events.at(-1);
      assert.equal(final?.type, "completed");
      if (final?.type === "completed") assert.equal(final.message.content, "answer");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("classifies reasoning-only streams instead of returning an empty completion", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponse([
        JSON.stringify({ choices: [{ delta: { reasoning_content: "checking the task" } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      ])) as typeof fetch;

    try {
      const config = makeLlmConfig({
        apiKey: "test-key",
        baseUrl: "http://localhost/v1",
        model: "custom-reasoning",
        reasoning: true,
      });
      const events = [];
      for await (const event of streamChat(config, [{ role: "user", content: "hi" }])) events.push(event);
      const error = events.find((event) => event.type === "error");
      assert.ok(error?.type === "error");
      assert.ok(error?.error instanceof IncompleteLlmResponseError);
      assert.equal((error?.error as IncompleteLlmResponseError).reason, "reasoning_only");
      assert.equal(events.some((event) => event.type === "completed"), false);
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

  it("uses the native xAI Grok 4.3 adapter without a fake effort parameter", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "ok" } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      ]);
    }) as typeof fetch;

    try {
      const config = makeLlmConfig({
        apiKey: "test-key",
        baseUrl: "https://api.x.ai/v1",
        model: "xai/grok-4.3",
      });
      for await (const _event of streamChat(config, [{ role: "user", content: "hi" }])) {
        // Consume the native adapter stream.
      }
      assert.equal(requestUrl, "https://api.x.ai/v1/chat/completions");
      assert.equal(requestBody?.model, "grok-4.3");
      assert.equal(requestBody?.reasoning_effort, undefined);
      assert.equal(requestBody?.max_completion_tokens, 30_000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("omits stream_options when supportsUsageInStreaming is explicitly false", async () => {
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
        model: "gpt-4o-mini",
        compat: { supportsUsageInStreaming: false },
      });
      for await (const _event of streamChat(config, [{ role: "user", content: "hi" }])) {
        // Consume the stream to force request construction and completion.
      }
      assert.equal(requestBody?.stream_options, undefined, "stream_options must be absent");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("includes stream_options by default when supportsUsageInStreaming is not set", async () => {
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
        model: "gpt-4o-mini",
      });
      for await (const _event of streamChat(config, [{ role: "user", content: "hi" }])) {
        // Consume the stream to force request construction and completion.
      }
      assert.deepEqual(requestBody?.stream_options, { include_usage: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws LlmTimeoutError when the stream stalls and times out", async () => {
    const originalFetch = globalThis.fetch;
    // Return a response that never produces data, so the internal timeout fires.
    globalThis.fetch = (async () => new Response(
      new ReadableStream({ start(_ctrl) { /* never enqueue */ } }),
      { headers: { "Content-Type": "text/event-stream" } },
    )) as typeof fetch;

    try {
      const config = makeLlmConfig({
        apiKey: "test-key",
        baseUrl: "http://localhost/v1",
        model: "gpt-4o-mini",
        timeoutMs: 10,
      });
      await assert.rejects(
        async () => {
          for await (const _event of streamChat(config, [{ role: "user", content: "hi" }])) { /* consume */ }
        },
        (err: unknown) => {
          assert.ok(err instanceof LlmTimeoutError, `expected LlmTimeoutError but got ${err?.constructor?.name ?? String(err)}`);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("resets idle timeout on stream chunks and reports stream idle when they stop", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
          ));
          setTimeout(() => {
            ctrl.enqueue(new TextEncoder().encode(
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            ));
            ctrl.close();
          }, 10);
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    )) as typeof fetch;

    try {
      const config = makeLlmConfig({
        apiKey: "test-key",
        baseUrl: "http://localhost/v1",
        model: "gpt-4o-mini",
        timeoutMs: 100,
        firstResponseTimeoutMs: 50,
        streamIdleTimeoutMs: 25,
      });
      const events = [];
      for await (const event of streamChat(config, [{ role: "user", content: "hi" }])) {
        events.push(event);
      }
      assert.equal(events.at(-1)?.type, "completed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports stream idle timeout metadata after partial stream output", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
          ));
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    )) as typeof fetch;

    try {
      const config = makeLlmConfig({
        apiKey: "test-key",
        baseUrl: "http://localhost/v1",
        model: "gpt-4o-mini",
        timeoutMs: 100,
        firstResponseTimeoutMs: 50,
        streamIdleTimeoutMs: 20,
      });
      await assert.rejects(
        async () => {
          for await (const _event of streamChat(config, [{ role: "user", content: "hi" }])) { /* consume */ }
        },
        (err: unknown) => {
          assert.ok(err instanceof LlmTimeoutError);
          assert.equal(err.phase, "stream_idle");
          assert.equal(err.timeoutMs, 20);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("recognises Pi provider timeout messages with the normalisation regex", () => {
    // The Pi error normalisation logic uses this regex to decide whether to
    // yield LlmTimeoutError instead of a plain Error.
    assert.ok(/timed? ?out|timeout|request timed/i.test("Request timed out."));
    assert.ok(/timed? ?out|timeout|request timed/i.test("request timed out after 30s"));
    assert.ok(!/timed? ?out|timeout|request timed/i.test("Invalid API key"));
  });
});
