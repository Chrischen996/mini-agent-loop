import { describe, it, expect } from "vitest";
import { tuiReducer, createInitialState } from "../src/tui/state.ts";
import type { LoopEvent } from "../src/loop.ts";

describe("Max tokens handling", () => {
  it("should show helpful tip when max_tokens is reached", () => {
    const initial = createInitialState();
    const errorEvent: LoopEvent = {
      type: "error",
      message: "LLM output reached max_tokens (4096); increase maxTokens or continue the task.",
    };

    const next = tuiReducer(initial, errorEvent);

    expect(next.status).toBe("Output truncated");
    expect(next.taskStatus).toBe("failed");
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].kind).toBe("error");
    expect(next.messages[0].text).toContain("💡 Tip: Use /continue");
    expect(next.messages[0].text).toContain("higher max_tokens");
  });

  it("should detect OutputTruncatedError by name pattern", () => {
    const initial = createInitialState();
    const errorEvent: LoopEvent = {
      type: "error",
      message: "OutputTruncatedError: Generation stopped",
    };

    const next = tuiReducer(initial, errorEvent);

    expect(next.status).toBe("Output truncated");
    expect(next.messages[0].text).toContain("/continue");
  });

  it("should handle normal errors without special tip", () => {
    const initial = createInitialState();
    const errorEvent: LoopEvent = {
      type: "error",
      message: "Network timeout",
    };

    const next = tuiReducer(initial, errorEvent);

    expect(next.status).toBe("Request failed");
    expect(next.messages[0].text).not.toContain("/continue");
    expect(next.messages[0].text).toBe("Network timeout");
  });

  it("should preserve error message content when adding tip", () => {
    const initial = createInitialState();
    const originalMessage = "LLM output reached max_tokens (8192)";
    const errorEvent: LoopEvent = {
      type: "error",
      message: originalMessage,
    };

    const next = tuiReducer(initial, errorEvent);

    expect(next.messages[0].text).toContain(originalMessage);
    expect(next.messages[0].text.split("\n")[0]).toBe(originalMessage);
  });
});
