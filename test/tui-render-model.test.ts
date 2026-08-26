import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toMessageRenderModel } from "../src/tui/render-model.ts";

describe("TUI render model", () => {
  it("maps presentation markers without changing message content", () => {
    const user = { kind: "user" as const, text: "hello", displayText: "hello" };
    const assistant = { kind: "assistant" as const, text: "answer" };
    assert.deepEqual(toMessageRenderModel(user), { kind: "user", marker: "❯", text: "hello" });
    assert.deepEqual(toMessageRenderModel(assistant), { kind: "assistant", marker: "⏺", text: "answer" });
  });

  it("keeps tool state and result presentation-only", () => {
    const tool = {
      kind: "tool_call" as const,
      id: "t1",
      name: "read",
      args: "{}",
      rawArgs: {},
      status: "done" as const,
      result: "file contents",
      startedAt: 1,
    };
    assert.deepEqual(toMessageRenderModel(tool), {
      kind: "tool", marker: "⎿", label: "read", state: "done", text: "file contents",
    });
  });
});

