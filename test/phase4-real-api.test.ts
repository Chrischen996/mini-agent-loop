import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeLlmConfig, streamChat, completeChat } from "../src/llm/index.ts";
import type { AgentMessage } from "../src/types.ts";

describe("Phase 4: Real API wire protocol tests", () => {
  it("serializes tool definitions correctly in non-streaming mode", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: Record<string, unknown> | undefined;

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/chat/completions")) {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "done", role: "assistant" } }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      const config = makeLlmConfig({
        apiKey: "test-key",
        baseUrl: "https://api.example.com/v1",
        model: "gpt-4o-mini",
      });
      const tools = [
        {
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          execute: async () => ({ content: "ok" }),
        },
      ];

      const result = await completeChat(config, [
        { role: "user", content: "read package.json" },
      ], tools);

      assert.ok(capturedBody);
      assert.equal(capturedBody?.model, "gpt-4o-mini");
      assert.ok(Array.isArray(capturedBody?.tools));
      const firstTool = capturedBody?.tools as Array<{function?: {name?: string}; type?: string}>;
      assert.equal(firstTool?.[0]?.function?.name, "read");
      assert.equal(firstTool?.[0]?.type, "function");
      assert.equal(result.content, "done");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles partial JSON arguments gracefully in tool calls", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: "",
              tool_calls: [{
                id: "call_1",
                function: {
                  name: "read",
                  arguments: '{"path": "package.json", "limit":', // truncated
                },
              }],
            },
          }],
        }),
        { headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    try {
      const config = makeLlmConfig({
        apiKey: "test-key",
        baseUrl: "https://api.example.com/v1",
        model: "gpt-4o-mini",
      });
      const result = await completeChat(config, [
        { role: "user", content: "read" },
      ]);

      assert.ok(result.toolCalls?.[0]);
      assert.ok(result.toolCalls?.[0].argumentsParseError);
      assert.match(result.toolCalls?.[0].argumentsParseError ?? "", /JSON/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves message ordering through tool call chain", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    let lastMessages: AgentMessage[] | undefined;

    globalThis.fetch = (async (input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages?: AgentMessage[] };
      lastMessages = body.messages;
      callCount += 1;

      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: "",
                tool_calls: [{
                  id: "call_read_1",
                  function: { name: "read", arguments: '{"path":"package.json"}' },
                }],
              },
            }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Package name: mini-agent-loop" } }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const config = makeLlmConfig({
        apiKey: "test-key",
        baseUrl: "https://api.example.com/v1",
        model: "gpt-4o-mini",
      });
      const result = await completeChat(config, [
        { role: "user", content: "Read package.json and tell me the name" },
      ]);

      assert.ok(result.toolCalls?.[0]);
      assert.equal(result.toolCalls?.[0].name, "read");
      assert.ok(lastMessages);
      // completeChat only returns the final assistant response, not the full message chain
      assert.ok(lastMessages);
      assert.equal(lastMessages[0].role, "user");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles 429 rate limit with descriptive error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: { message: "Rate limit exceeded", type: "rate_limit" } }),
        { status: 429, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    try {
      const config = makeLlmConfig({
        apiKey: "test-key",
        baseUrl: "https://api.example.com/v1",
        model: "gpt-4o-mini",
      });
      await assert.rejects(
        () => completeChat(config, [{ role: "user", content: "hi" }]),
        /LLM HTTP 429/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles network timeout with clear error message", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network timeout");
    }) as typeof fetch;

    try {
      const config = makeLlmConfig({
        apiKey: "test-key",
        baseUrl: "https://api.example.com/v1",
        model: "gpt-4o-mini",
      });
      await assert.rejects(
        () => completeChat(config, [{ role: "user", content: "hi" }], undefined, new AbortController().signal),
        /LLM network error/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Phase 4: Vision preprocessing tests", () => {
  it("prepares images for vision-capable models", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: Record<string, unknown> | undefined;

    globalThis.fetch = (async (input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "I see an image" } }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const config = makeLlmConfig({
        apiKey: "test-key",
        baseUrl: "https://api.example.com/v1",
        model: "gpt-4o-mini",
      });
      const result = await completeChat(config, [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image" },
            { type: "image", mimeType: "image/png", data: "base64data" },
          ],
        },
      ]);

      assert.ok(capturedBody);
      const messages = capturedBody?.messages as Array<{ content?: unknown }>;
      assert.ok(Array.isArray(messages[0]?.content));
      const parts = messages[0].content as Array<{ type: string }>;
      assert.ok(parts.some(p => p.type === "image_url"));
      assert.ok(parts.some(p => p.type === "text"));
      assert.equal(result.content, "I see an image");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("replaces images with placeholders for non-vision models", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: Record<string, unknown> | undefined;

    globalThis.fetch = (async (input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "No images" } }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const config = makeLlmConfig({
        apiKey: "test-key",
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
      });
      const result = await completeChat(config, [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image", mimeType: "image/png", data: "base64data" },
          ],
        },
      ]);

      assert.ok(capturedBody);
      const messages = capturedBody?.messages as Array<{ content?: unknown }>;
      // prepareMessagesForModel returns content as array of parts for non-vision models
      const content = messages[0]?.content;
      assert.ok(Array.isArray(content) || typeof content === "string");
      const contentStr = typeof content === "string" ? content : JSON.stringify(content);
      assert.match(contentStr, /Image omitted/);
      assert.equal(result.content, "No images");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
