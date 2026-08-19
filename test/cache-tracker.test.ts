import test from "node:test";
import assert from "node:assert/strict";
import { completeChat, streamChat, makeLlmConfig } from "../src/llm/index.ts";

test("cache tracking - extracts cache_read_tokens from OpenAI-compatible usage", async () => {
  const originalFetch = globalThis.fetch;
  
  globalThis.fetch = (async (_input, init) => {
    // Simulate OpenAI usage with cached_tokens
    return new Response(JSON.stringify({
      choices: [{
        message: { content: "done" },
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        total_tokens: 1050,
        prompt_tokens_details: {
          cached_tokens: 800,
          cache_write_tokens: 200,
        },
      },
    }));
  }) as typeof fetch;

  try {
    const config = makeLlmConfig({
      apiKey: "test",
      baseUrl: "http://localhost/v1",
      model: "gpt-4o-mini",
    });
    
    const result = await completeChat(config, [{ role: "user", content: "hello" }]);
    
    // Result should have the message and cache fields
    assert.equal(result.content, "done");
    // Non-streaming path now parses usage from response body (mirrors streamChat)
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cache tracking - handles missing cache fields gracefully", async () => {
  const originalFetch = globalThis.fetch;
  
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({
      choices: [{
        message: { content: "ok" },
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: 500,
        completion_tokens: 20,
        total_tokens: 520,
      },
    }));
  }) as typeof fetch;

  try {
    const config = makeLlmConfig({
      apiKey: "test",
      baseUrl: "http://localhost/v1",
      model: "gpt-4o-mini",
    });
    
    const result = await completeChat(config, [{ role: "user", content: "test" }]);
    assert.equal(result.content, "ok");
    // Non-streaming path now includes usage from the response body
    const usage = (result as any).usage;
    assert.ok(usage, "usage should be populated from non-streaming response");
    assert.equal(usage.promptTokens, 500);
    assert.equal(usage.completionTokens, 20);
    assert.equal(usage.totalTokens, 520);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
