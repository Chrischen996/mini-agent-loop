import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactHistory } from "../src/context.ts";
import type { AgentMessage } from "../src/types.ts";

describe("context compaction", () => {
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
});
