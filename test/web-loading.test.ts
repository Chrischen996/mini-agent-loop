import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChatStreamState } from "../apps/web/src/lib/event-adapter.ts";

describe("Web loading lifecycle", () => {
  it("responds immediately and keeps the same turn clock across actual activity changes", () => {
    const state = new ChatStreamState();
    state.beginTurn(1000);
    assert.equal(state.activity?.label, "Working");
    state.apply({ type: "assistant_delta", kind: "reasoning", text: "inspect" });
    assert.equal(state.activity?.label, "Thinking");
    const clock = state.activity;
    state.apply({ type: "assistant_delta", kind: "reasoning", text: " more" });
    assert.equal(state.activity, clock, "repeated chunks must not restart the shimmer");
    assert.equal(state.activity?.startedAt, 1000);
    state.apply({ type: "assistant_delta", kind: "answer", text: "reply" });
    assert.equal(state.activity?.label, "Responding");
    assert.notEqual(state.activity, clock);
    state.apply({ type: "tool_start", id: "one", name: "read" });
    state.apply({ type: "tool_start", id: "two", name: "grep" });
    assert.equal(state.activity?.label, "Running grep");
    state.apply({ type: "tool_end", id: "two" });
    assert.equal(state.activity?.label, "Running read");
    state.apply({ type: "tool_end", id: "one" });
    assert.equal(state.activity?.label, "Working");
    state.apply({ type: "request_retry" });
    assert.equal(state.activity?.label, "Reconnecting");
    state.apply({ type: "permission_required", requestId: "permission", tool: "write" });
    assert.equal(state.activity?.label, "Waiting for permission");
    state.apply({ type: "done" });
    assert.equal(state.activity, null);
  });

  it("clears the loading state on every stop path and starts a fresh clock on Continue", () => {
    for (const type of ["error", "aborted", "max_turns", "run_stopped", "done"]) {
      const state = new ChatStreamState();
      state.beginTurn(1000);
      state.apply({ type });
      const stoppedActivity = state.activity;
      assert.equal(stoppedActivity, null, type);
      state.beginTurn(2000);
      state.apply({ type: "auto_continue" });
      assert.equal(state.activity?.startedAt, 2000);
      assert.equal(state.activity?.label, "Continuing");
    }
  });

  it("does not revive a previous turn's interrupted tools in the next loading label", () => {
    const state = new ChatStreamState();
    state.beginTurn();
    state.apply({ type: "tool_start", id: "old", name: "read" });
    state.apply({ type: "aborted" });
    state.beginTurn();
    state.apply({ type: "tool_start", id: "new", name: "grep" });
    state.apply({ type: "tool_end", id: "new" });
    assert.equal(state.activity?.label, "Working");
  });
});
