import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { restoreTuiSession } from "../src/tui/session-serialization.ts";
import { buildTuiSystemPrompt, createTuiAgentHistory } from "../src/tui/system-prompt.ts";
import type { PersistedSession } from "../src/session-store.ts";

describe("TUI system prompt", () => {
  it("includes repository instructions and persistent memory", () => {
    const prompt = buildTuiSystemPrompt("plan", {
      agentsMd: "Follow the repository-specific rules.",
      memorySection: "The user prefers concise diffs.",
    });

    assert.match(prompt, /Follow the repository-specific rules/);
    assert.match(prompt, /The user prefers concise diffs/);

    const history = createTuiAgentHistory("plan", {
      agentsMd: "Follow the repository-specific rules.",
      memorySection: "The user prefers concise diffs.",
    });
    assert.equal(history[0]?.role, "system");
    assert.match(String(history[0]?.content), /Follow the repository-specific rules/);
    assert.match(String(history[0]?.content), /The user prefers concise diffs/);

    const session = {
      id: "session-1",
      createdAt: 1,
      messages: [{ role: "system", content: "old system prompt" }],
    } as PersistedSession;
    const restored = restoreTuiSession(session, prompt);
    assert.equal(restored.history[0]?.content, prompt);
  });
});
