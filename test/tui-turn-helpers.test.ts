import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LlmTimeoutError } from "../src/llm/retry.ts";
import { formatLlmTimeoutMessage } from "../src/tui/turn-helpers.ts";

describe("formatLlmTimeoutMessage", () => {
  it("includes the timeout phase, duration, and partial preview", () => {
    const error = new LlmTimeoutError("partial\nanswer", undefined, {
      phase: "stream_idle",
      timeoutMs: 60_000,
    });

    assert.equal(
      formatLlmTimeoutMessage(error),
      "LLM timeout (stream idle, 60s) - partial response saved: partial answer",
    );
  });

  it("does not render empty parentheses when no partial response exists", () => {
    const error = new LlmTimeoutError(undefined, undefined, {
      phase: "first_response",
      timeoutMs: 120_000,
    });

    const message = formatLlmTimeoutMessage(error);
    assert.equal(message, "LLM timeout (first response, 120s) - no partial response received");
    assert.ok(!message.includes("()"));
  });
});
