import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fromPiAssistant, toPiContext } from "../src/llm/wire.ts";
import type { AssistantMessage as PiAssistantMessage } from "../src/pi-ai/types.ts";
import type { AssistantMessage } from "../src/types.ts";

const emptyUsage = {
  input: 3,
  output: 7,
  cacheRead: 2,
  cacheWrite: 1,
  reasoning: 4,
  totalTokens: 13,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function claudeAssistant(): PiAssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: "need to inspect the file first",
        thinkingSignature: "sig_abc",
      },
      { type: "text", text: "I'll read it." },
      {
        type: "toolCall",
        id: "toolu_1",
        name: "read",
        arguments: { path: "src/loop.ts" },
      },
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: emptyUsage,
    stopReason: "toolUse",
    timestamp: 1,
  };
}

describe("Claude thinking wire roundtrip", () => {
  it("keeps thinking signatures when converting from Anthropic assistant content", () => {
    const { message, usage } = fromPiAssistant(claudeAssistant());

    assert.equal(message.content, "I'll read it.");
    assert.deepEqual(message.thinking, [
      {
        type: "thinking",
        thinking: "need to inspect the file first",
        thinkingSignature: "sig_abc",
      },
    ]);
    assert.deepEqual(message.toolCalls, [
      { id: "toolu_1", name: "read", arguments: { path: "src/loop.ts" } },
    ]);
    assert.equal(usage.reasoningTokens, 4);
  });

  it("replays thinking blocks before text and tool calls on the next Anthropic turn", () => {
    const converted = fromPiAssistant(claudeAssistant()).message;
    const context = toPiContext([
      converted,
      {
        role: "tool",
        toolCallId: "toolu_1",
        name: "read",
        content: "export function runAgent",
      },
    ]);

    const assistant = context.messages[0];
    assert.equal(assistant?.role, "assistant");
    if (assistant?.role !== "assistant") return;

    assert.deepEqual(
      assistant.content.map((part) => part.type),
      ["thinking", "text", "toolCall"],
    );
    const thinking = assistant.content[0];
    assert.equal(thinking?.type, "thinking");
    if (thinking?.type === "thinking") {
      assert.equal(thinking.thinking, "need to inspect the file first");
      assert.equal(thinking.thinkingSignature, "sig_abc");
    }
  });

  it("preserves redacted thinking payloads for Anthropic continuity", () => {
    const converted = fromPiAssistant({
      ...claudeAssistant(),
      content: [
        {
          type: "thinking",
          thinking: "[Reasoning redacted]",
          thinkingSignature: "opaque-data",
          redacted: true,
        },
        { type: "text", text: "done" },
      ],
      stopReason: "stop",
    }).message;

    assert.deepEqual(converted.thinking, [
      {
        type: "thinking",
        thinking: "[Reasoning redacted]",
        thinkingSignature: "opaque-data",
        redacted: true,
      },
    ]);

    const replayed = toPiContext([converted]).messages[0];
    assert.equal(replayed?.role, "assistant");
    if (replayed?.role !== "assistant") return;
    const thinking = replayed.content[0];
    assert.equal(thinking?.type, "thinking");
    if (thinking?.type === "thinking") {
      assert.equal(thinking.redacted, true);
      assert.equal(thinking.thinkingSignature, "opaque-data");
    }
  });

  it("does not invent thinking on ordinary assistant text", () => {
    const message: AssistantMessage = { role: "assistant", content: "hello" };
    const replayed = toPiContext([message]).messages[0];
    assert.equal(replayed?.role, "assistant");
    if (replayed?.role !== "assistant") return;
    assert.deepEqual(replayed.content, [{ type: "text", text: "hello" }]);
  });
});
