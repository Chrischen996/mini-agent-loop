import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { imagePart, textPart } from "../src/content.ts";
import {
  completeChat,
  makeLlmConfig,
  resolveOutputTokenLimit,
} from "../src/llm/index.ts";
import type { AgentMessage } from "../src/types.ts";

const llm = makeLlmConfig({
  apiKey: "llm-test-key",
  baseUrl: "https://llm.example/v1",
  model: "deepseek-chat",
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("completeChat wire protocol", () => {
  it("uses a balanced output limit for models whose capability fills the context window", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ choices: [{ message: { content: "done" } }] });
    }) as typeof fetch;

    try {
      const grok = makeLlmConfig({
        apiKey: "test",
        baseUrl: "https://gateway.example/v1",
        model: "xai/grok-4.5",
      });
      assert.equal(grok.contextWindow, 500_000);
      assert.equal(grok.maxTokens, 32_768);
      await completeChat(grok, [{ role: "user", content: "hello" }]);
      assert.equal(requestBody?.max_tokens, 32_768);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("caps default output at 25% for small windows and preserves explicit limits", () => {
    assert.equal(resolveOutputTokenLimit(100_000, 16_000), 4_000);
    assert.equal(resolveOutputTokenLimit(8_000, 128_000), 8_000);
    assert.equal(resolveOutputTokenLimit(100_000, 16_000, 6_000), 6_000);
    assert.equal(resolveOutputTokenLimit(100_000, 16_000, 99_000), 15_999);
    assert.equal(resolveOutputTokenLimit(100_000, 16_000, Number.NaN), 1);
  });

  it("passes the configured thinking level to an OpenAI-compatible reasoning model", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ choices: [{ message: { content: "done" } }] });
    }) as typeof fetch;

    try {
      const reasoning = makeLlmConfig({
        apiKey: "reasoning-key",
        baseUrl: "https://gateway.example/v1",
        model: "custom-reasoning",
        reasoning: true,
        thinkingLevel: "high",
      });
      await completeChat(reasoning, [{ role: "user", content: "plan" }]);
      assert.equal(requestBody?.reasoning_effort, "high");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses Agnes AI's documented endpoint and thinking parameter", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
      });
    }) as typeof fetch;

    try {
      const agnes = makeLlmConfig({
        apiKey: "agnes-test-key",
        baseUrl: "https://apihub.agnes-ai.com/v1",
        model: "agnes-ai/agnes-2.0-flash",
      });
      await completeChat(agnes, [{ role: "user", content: "plan a task" }]);

      assert.equal(requestUrl, "https://apihub.agnes-ai.com/v1/chat/completions");
      assert.equal(requestBody?.model, "agnes-2.0-flash");
      assert.deepEqual(requestBody?.chat_template_kwargs, { enable_thinking: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("serializes tools, tool results, and maps tool calls", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let requestInit: RequestInit | undefined;

    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return jsonResponse({
        choices: [{
          message: {
            content: "",
            tool_calls: [{
              id: "call_read_1",
              type: "function",
              function: {
                name: "read",
                arguments: '{"path":"package.json"}',
              },
            }],
          },
        }],
      });
    }) as typeof fetch;

    try {
      const messages: AgentMessage[] = [
        { role: "system", content: "You are an agent." },
        { role: "user", content: "read package.json" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "call_previous",
            name: "read",
            arguments: { path: "README.md" },
          }],
        },
        {
          role: "tool",
          toolCallId: "call_previous",
          name: "read",
          content: [textPart("previous result")],
        },
      ];
      const tool = {
        name: "read",
        description: "Read a workspace file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        execute: async () => ({ content: "unused" }),
      };

      const result = await completeChat(llm, messages, [tool]);
      assert.equal(requestUrl, "https://llm.example/v1/chat/completions");
      assert.equal(requestInit?.method, "POST");
      assert.equal(
        new Headers(requestInit?.headers).get("authorization"),
        "Bearer llm-test-key",
      );

      const body = JSON.parse(String(requestInit?.body)) as {
        model: string;
        max_tokens: number;
        messages: Array<Record<string, unknown>>;
        tools: Array<Record<string, unknown>>;
        tool_choice: string;
      };
      assert.equal(body.model, "deepseek-chat");
      assert.equal(body.max_tokens, 16384);
      assert.equal(body.tool_choice, "auto");
      assert.equal(body.messages[3]?.role, "tool");
      assert.equal(body.messages[3]?.tool_call_id, "call_previous");
      assert.equal(body.messages[3]?.content, "previous result");
      assert.deepEqual(body.tools[0], {
        type: "function",
        function: {
          name: "read",
          description: "Read a workspace file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      });
      assert.equal(result.toolCalls?.[0]?.id, "call_read_1");
      assert.deepEqual(result.toolCalls?.[0]?.arguments, {
        path: "package.json",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("maps image parts to image_url only for a vision-capable model", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ choices: [{ message: { content: "seen" } }] });
    }) as typeof fetch;

    try {
      const vision = makeLlmConfig({
        apiKey: "vision-key",
        baseUrl: "https://vision.example/v1",
        model: "gpt-4o-mini",
      });
      await completeChat(vision, [{
        role: "user",
        content: [
          textPart("describe"),
          imagePart("image/png", "aW1hZ2U=", "shot.png"),
        ],
      }]);

      const messages = requestBody?.messages as Array<Record<string, unknown>>;
      const content = messages[0]?.content as Array<Record<string, unknown>>;
      assert.deepEqual(content[1], {
        type: "image_url",
        image_url: { url: "data:image/png;base64,aW1hZ2U=" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps malformed tool arguments as a parse error for the loop", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => jsonResponse({
      choices: [{
        message: {
          content: "",
          tool_calls: [{
            id: "bad-json",
            function: { name: "read", arguments: "{not-json" },
          }],
        },
      }],
    })) as typeof fetch;

    try {
      const result = await completeChat(llm, [{ role: "user", content: "go" }]);
      assert.deepEqual(result.toolCalls?.[0]?.arguments, {});
      assert.match(result.toolCalls?.[0]?.argumentsParseError ?? "", /JSON/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("completeChat errors", () => {
  it("reports provider HTTP errors without leaking the API key", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => jsonResponse({ error: "rate limited" }, 429)) as typeof fetch;

    try {
      await assert.rejects(
        () => completeChat(llm, [{ role: "user", content: "hello" }]),
        (error: unknown) => {
          assert(error instanceof Error);
          assert.match(error.message, /LLM HTTP 429/);
          assert.doesNotMatch(error.message, /llm-test-key/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports network errors with a stable prefix", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("socket closed");
    }) as typeof fetch;

    try {
      await assert.rejects(
        () => completeChat(llm, [{ role: "user", content: "hello" }]),
        /LLM network error: socket closed/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports invalid JSON and empty choices clearly", async () => {
    const originalFetch = globalThis.fetch;
    const responses = [
      new Response("not-json", { status: 200 }),
      jsonResponse({ choices: [] }),
    ];
    globalThis.fetch = (async () => responses.shift()!) as typeof fetch;

    try {
      await assert.rejects(
        () => completeChat(llm, [{ role: "user", content: "hello" }]),
        /response is not valid JSON/,
      );
      await assert.rejects(
        () => completeChat(llm, [{ role: "user", content: "hello" }]),
        /missing choices\[0\]\.message/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces max-token truncation instead of treating it as a complete answer", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse({
        choices: [{
          message: { content: "partial answer cut off mid" },
          finish_reason: "length",
        }],
      })) as typeof fetch;

    try {
      await assert.rejects(
        () => completeChat(llm, [{ role: "user", content: "hello" }]),
        /reached max_tokens/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces content_filter and error finish reasons", async () => {
    const originalFetch = globalThis.fetch;
    const responses = [
      jsonResponse({
        choices: [{
          message: { content: "" },
          finish_reason: "content_filter",
        }],
      }),
      jsonResponse({
        choices: [{
          message: { content: "" },
          finish_reason: "error",
        }],
      }),
    ];
    globalThis.fetch = (async () => responses.shift()!) as typeof fetch;

    try {
      await assert.rejects(
        () => completeChat(llm, [{ role: "user", content: "hello" }]),
        /finish_reason=content_filter/,
      );
      await assert.rejects(
        () => completeChat(llm, [{ role: "user", content: "hello" }]),
        /finish_reason=error/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
