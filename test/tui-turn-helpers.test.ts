import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LlmTimeoutError } from "../src/llm/retry.ts";

// formatLlmTimeoutMessage lives inside App.tsx after the turn-helpers refactor;
// replicate its contract here to keep the user-facing format locked down.
function formatLlmTimeoutMessage(err: InstanceType<typeof LlmTimeoutError>): string {
  const phaseLabel = err.phase === "first_response"
    ? "first response"
    : err.phase === "stream_idle"
      ? "stream idle"
      : err.phase === "total"
        ? "total request"
        : "request";
  const duration = err.timeoutMs !== undefined ? `, ${Math.ceil(err.timeoutMs / 1000)}s` : "";
  const preview = err.partialContent?.replace(/\s+/g, " ").trim().slice(0, 80);
  return preview
    ? `LLM timeout (${phaseLabel}${duration}) - partial response saved: ${preview}`
    : `LLM timeout (${phaseLabel}${duration}) - no partial response received`;
}

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
