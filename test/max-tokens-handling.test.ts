import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tuiReducer, createInitialState } from "../src/tui/state.js";

function errorText(state: ReturnType<typeof createInitialState>): string {
  const message = state.messages[0];
  assert.equal(message?.kind, "error");
  if (message?.kind !== "error") throw new Error("Expected an error message");
  return message.text;
}

describe("max-tokens handling", () => {
  it("shows helpful tip when max_tokens is reached", () => {
    const initial = createInitialState("test-model");
    const next = tuiReducer(initial, {
      type: "LOOP_EVENT",
      event: {
        type: "error",
        message: "LLM output reached max_tokens (4096); increase maxTokens or continue the task.",
      },
    });
    assert.equal(next.status, "Output truncated");
    assert.equal(next.taskStatus, "failed");
    assert.equal(next.messages.length, 1);
    assert.ok(errorText(next).includes("💡 Tip: Use /continue"));
    assert.ok(errorText(next).includes("higher max_tokens"));
  });

  it("detects OutputTruncatedError by name pattern", () => {
    const initial = createInitialState("test-model");
    const next = tuiReducer(initial, {
      type: "LOOP_EVENT",
      event: {
        type: "error",
        message: "OutputTruncatedError: Generation stopped",
      },
    });
    assert.equal(next.status, "Output truncated");
    assert.ok(errorText(next).includes("/continue"));
  });

  it("handles normal errors without special tip", () => {
    const initial = createInitialState("test-model");
    const next = tuiReducer(initial, {
      type: "LOOP_EVENT",
      event: { type: "error", message: "Network timeout" },
    });
    assert.equal(next.status, "Request failed");
    assert.equal(errorText(next), "Network timeout");
    assert.ok(!errorText(next).includes("/continue"));
  });

  it("preserves original message when adding tip", () => {
    const initial = createInitialState("test-model");
    const originalMessage = "LLM output reached max_tokens (8192)";
    const next = tuiReducer(initial, {
      type: "LOOP_EVENT",
      event: { type: "error", message: originalMessage },
    });
    assert.ok(errorText(next).includes(originalMessage));
  });
});
