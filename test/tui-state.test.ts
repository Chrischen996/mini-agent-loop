import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, tuiReducer } from "../src/tui/state.ts";

describe("TUI sidebar state", () => {
  it("tracks the goal, workflow step, file path, and tool card", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "Inspect the workspace" });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: {
        type: "tool_start",
        call: { id: "call-1", name: "read", arguments: { path: "src/index.ts" } },
      },
    });

    assert.equal(state.goal, "Inspect the workspace");
    assert.deepEqual(state.touchedFiles, ["src/index.ts"]);
    assert.equal(state.steps[0]?.status, "running");
    assert.equal(state.toolCards[0]?.status, "running");

    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: {
        type: "tool_end",
        call: { id: "call-1", name: "read", arguments: { path: "src/index.ts" } },
        result: { content: "export const answer = 42;", isError: false },
      },
    });

    assert.equal(state.steps[0]?.status, "done");
    assert.equal(state.toolCards[0]?.status, "done");
    assert.equal(state.toolCards[0]?.preview, "export const answer = 42;");
    assert.ok((state.toolCards[0]?.durationMs ?? -1) >= 0);
  });

  it("clears sidebar state when the conversation is reset", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "Do work" });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "tool_start", call: { id: "call-1", name: "bash", arguments: { command: "pwd" } } },
    });
    state = tuiReducer(state, { type: "RESET" });
    assert.equal(state.goal, "");
    assert.deepEqual(state.steps, []);
    assert.deepEqual(state.touchedFiles, []);
    assert.deepEqual(state.toolCards, []);
  });
});
