import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactHistory, estimateContextTokens, estimateTextTokens } from "../src/context.ts";
import type { AgentMessage } from "../src/types.ts";

describe("context compaction", () => {
  it("estimates mixed text and multimodal content conservatively", () => {
    assert.ok(estimateTextTokens("中文") > estimateTextTokens("abcd"));
    assert.ok(estimateContextTokens([{ role: "user", content: "hello" }]) > 0);
  });

  it("keeps system and recent messages while summarizing older context", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "system" },
      ...Array.from({ length: 8 }, (_, index) => ({
        role: "user" as const,
        content: `old message ${index} ${"x".repeat(30)}`,
      })),
      { role: "user", content: "latest" },
      { role: "assistant", content: "latest answer" },
    ];
    const compacted = compactHistory(history, { maxChars: 120, keepRecentMessages: 2 });
    assert.equal(compacted[0]?.role, "system");
    assert.match(compacted[1]?.role === "system" ? compacted[1].content : "", /Conversation summary/);
    assert.match(JSON.stringify(compacted), /old message 0/);
    assert.match(JSON.stringify(compacted), /latest answer/);
    assert.ok(compacted.length < history.length);
  });

  it("keeps an assistant tool call paired with its tool result", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "old" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read", arguments: {} }] },
      { role: "tool", toolCallId: "call-1", name: "read", content: "old result" },
      { role: "user", content: "latest" },
      { role: "assistant", content: "latest answer" },
    ];
    const compacted = compactHistory(history, { maxTokens: 10, keepRecentMessages: 3 });
    const calls = compacted
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.role === "assistant" ? message.toolCalls ?? [] : []);
    const results = compacted
      .filter((message) => message.role === "tool")
      .map((message) => message.role === "tool" ? message.toolCallId : "");
    assert.ok(calls.length > 0);
    assert.ok(calls.every((call) => results.includes(call.id)));
  });
});
