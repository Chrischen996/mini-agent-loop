import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeLlmConfig } from "../src/llm.ts";
import { runAgentTurn } from "../src/loop.ts";
import type { AssistantMessage } from "../src/types.ts";

describe("abort signal", () => {
  it("stops before the next model call when aborted after tools", async () => {
    const llm = makeLlmConfig({
      apiKey: "test",
      baseUrl: "http://localhost/v1",
      model: "faux",
    });
    const ac = new AbortController();
    let chatCalls = 0;
    const events: string[] = [];

    const chat = async (): Promise<AssistantMessage> => {
      chatCalls += 1;
      if (chatCalls === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "noop", arguments: {} }],
        };
      }
      return { role: "assistant", content: "should-not-run" };
    };

    const tools = [
      {
        name: "noop",
        description: "noop",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          ac.abort();
          return { content: "ok" };
        },
      },
    ];

    const messages = await runAgentTurn(
      [{ role: "system", content: "sys" }],
      "hi",
      {
        llm,
        tools,
        chat,
        signal: ac.signal,
        onEvent: (event) => events.push(event.type),
      },
    );

    assert.equal(chatCalls, 1);
    assert.ok(events.includes("aborted"));
    assert.equal(
      messages.filter(
        (m) => m.role === "assistant" && m.content === "should-not-run",
      ).length,
      0,
    );
  });

  it("fills remaining tool results when aborted mid-batch", async () => {
    const llm = makeLlmConfig({
      apiKey: "test",
      baseUrl: "http://localhost/v1",
      model: "faux",
    });
    const ac = new AbortController();
    const events: string[] = [];

    const chat = async (): Promise<AssistantMessage> => ({
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "c1", name: "slow", arguments: {} },
        { id: "c2", name: "slow", arguments: {} },
      ],
    });

    const tools = [
      {
        name: "slow",
        description: "slow",
        parameters: { type: "object", properties: {} },
        execute: async (_args: unknown, signal?: AbortSignal) => {
          if (!ac.signal.aborted) ac.abort();
          if (signal?.aborted) {
            const err = new Error("Aborted");
            err.name = "AbortError";
            throw err;
          }
          return { content: "ok" };
        },
      },
    ];

    const messages = await runAgentTurn(
      [{ role: "system", content: "sys" }],
      "hi",
      {
        llm,
        tools,
        chat,
        signal: ac.signal,
        onEvent: (event) => events.push(event.type),
      },
    );

    assert.ok(events.includes("aborted"));
    const toolMsgs = messages.filter((m) => m.role === "tool");
    assert.equal(toolMsgs.length, 2);
    assert.ok(toolMsgs.every((m) => m.role === "tool" && m.isError === true));
  });
});
