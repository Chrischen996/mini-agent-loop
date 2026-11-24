import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequestPermissionModeTool, MODE_REQUEST_TOOL_NAME } from "../src/tools/mode-request.ts";
import { resolveModeRequestDecision } from "../src/tui/mode-request.ts";
import { createInitialState, tuiReducer } from "../src/tui/state.ts";
import { PermissionManager } from "../src/permissions.ts";
import type { Tool } from "../src/tools/types.ts";

const writeTool: Tool = {
  name: "write",
  description: "write",
  parameters: { type: "object" },
  execute: async () => ({ content: "ok" }),
};

describe("model-initiated permission mode request", () => {
  it("records the request instead of switching the mode itself", async () => {
    const tool = createRequestPermissionModeTool();
    assert.equal(tool.name, MODE_REQUEST_TOOL_NAME);
    const result = await tool.execute({ mode: "bypass", reason: "Need to apply the fix" });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.modeRequest, { mode: "bypass", reason: "Need to apply the fix" });
    assert.match(String(result.content), /must confirm/i);
  });

  it("rejects a missing reason or an unknown mode", async () => {
    const tool = createRequestPermissionModeTool();
    const noReason = await tool.execute({ mode: "bypass", reason: "  " });
    assert.equal(noReason.isError, true);
    const badMode = await tool.execute({ mode: "approval" as unknown as "bypass", reason: "x" });
    assert.equal(badMode.isError, true);
  });

  it("is readable in plan mode so the request itself is never blocked", async () => {
    const manager = new PermissionManager("plan");
    const tool = createRequestPermissionModeTool();
    // authorize() throws for high-risk tools in plan mode; the request tool
    // must pass through, otherwise plan mode could never ask to leave plan mode.
    await manager.authorize("session", tool as Tool, { mode: "bypass", reason: "apply fix" }, undefined, () => {
      throw new Error("the mode request must not open a permission prompt");
    });
  });

  it("keeps plan mode unchanged until the user accepts", () => {
    const manager = new PermissionManager("plan");
    let state = createInitialState("test-model");
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "permission_mode_requested", mode: "bypass", reason: "apply the fix" },
    });
    assert.deepEqual(state.pendingModeRequest, { mode: "bypass", reason: "apply the fix" });
    assert.equal(state.permissionMode, "plan");
    assert.equal(manager.getMode(), "plan");
  });

  it("maps A to switch and D/Enter/Esc to keeping the current mode", () => {
    assert.equal(resolveModeRequestDecision("a", {}), "switch");
    assert.equal(resolveModeRequestDecision("A", {}), "switch");
    assert.equal(resolveModeRequestDecision("d", {}), "dismiss");
    assert.equal(resolveModeRequestDecision("D", {}), "dismiss");
    assert.equal(resolveModeRequestDecision("", { return: true }), "dismiss");
    assert.equal(resolveModeRequestDecision("", { escape: true }), "dismiss");
    assert.equal(resolveModeRequestDecision("x", {}), null);
  });

  it("survives the turn end so the card is still answerable", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "permission_mode_requested", mode: "bypass", reason: "apply the fix" },
    });
    state = tuiReducer(state, { type: "LOOP_EVENT", event: { type: "done", messages: [] } });
    assert.equal(state.busy, false);
    assert.deepEqual(state.pendingModeRequest, { mode: "bypass", reason: "apply the fix" });
  });

  it("clears the card when the user dismisses it", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "permission_mode_requested", mode: "bypass", reason: "apply the fix" },
    });
    state = tuiReducer(state, { type: "CLEAR_MODE_REQUEST" });
    assert.equal(state.pendingModeRequest, undefined);
  });

  it("still blocks real writes in plan mode", async () => {
    const manager = new PermissionManager("plan");
    await assert.rejects(
      manager.authorize("session", writeTool, { path: "a.txt" }, undefined, () => {}),
      /plan mode is analysis-only/,
    );
  });

  it("does not open a card when the session is already in that mode", () => {
    // Asking for the mode you are already in can only produce a no-op card.
    let state = createInitialState("test-model");
    assert.equal(state.permissionMode, "plan");
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "permission_mode_requested", mode: "plan", reason: "already here" },
    });
    assert.equal(state.pendingModeRequest, undefined);
    assert.match(state.status, /Already in plan mode/);
  });

  it("keeps the card status readable after the tool call completes", () => {
    // Regression: the tool name contains "permission", so the generic status
    // translator turned "request_permission_mode completed" into
    // "Waiting for permission" even though nothing was awaiting approval.
    let state = createInitialState("test-model");
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "permission_mode_requested", mode: "bypass", reason: "apply the fix" },
    });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: {
        type: "tool_end",
        call: { id: "call-1", name: MODE_REQUEST_TOOL_NAME, arguments: {} },
        result: { content: "Recorded a request to switch to bypass mode." },
      },
    });
    assert.match(state.status, /Mode switch requested: bypass/);
    assert.doesNotMatch(state.status, /Waiting for permission/);
    assert.equal(state.pendingModeRequest?.mode, "bypass");
  });

  it("clears the stale card status when the request is dismissed", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "permission_mode_requested", mode: "bypass", reason: "apply the fix" },
    });
    state = tuiReducer(state, { type: "CLEAR_MODE_REQUEST" });
    assert.equal(state.pendingModeRequest, undefined);
    // The status must not keep advertising a card that is no longer on screen.
    assert.doesNotMatch(state.status, /Mode switch requested/);
  });

  it("records who initiated a mode change for audit", () => {
    const manager = new PermissionManager("plan");
    const events: Array<{ source: string; mode: string; reason?: string }> = [];
    manager.onModeChange = (event) => {
      events.push({
        source: event.source,
        mode: event.mode,
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
      });
    };
    manager.setMode("bypass", "model_request", "needs to write files");
    assert.deepEqual(events, [{ source: "model_request", mode: "bypass", reason: "needs to write files" }]);
    // Defaults to a user-initiated change so existing call sites stay correct.
    manager.setMode("plan");
    assert.deepEqual(events[1], { source: "user", mode: "plan" });
  });

  it("does not emit an audit event when the mode does not change", () => {
    const manager = new PermissionManager("plan");
    let count = 0;
    manager.onModeChange = () => { count += 1; };
    manager.setMode("plan", "model_request", "no-op");
    assert.equal(count, 0);
  });

  it("survives an audit sink that throws", () => {
    const manager = new PermissionManager("plan");
    manager.onModeChange = () => { throw new Error("sink down"); };
    const change = manager.setMode("bypass", "model_request", "reason");
    assert.equal(change.changed, true);
    assert.equal(manager.getMode(), "bypass");
  });
});
