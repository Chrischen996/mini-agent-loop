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

  it("cycles permission mode with TOGGLE_PERMISSION_MODE", () => {
    let state = createInitialState("test-model");
    // Default is auto
    assert.equal(state.permissionMode, "auto");

    // Toggle to plan
    state = tuiReducer(state, { type: "TOGGLE_PERMISSION_MODE" });
    assert.equal(state.permissionMode, "plan");
    assert.equal(state.status, "权限模式: 计划");

    // Toggle to bypass
    state = tuiReducer(state, { type: "TOGGLE_PERMISSION_MODE" });
    assert.equal(state.permissionMode, "bypass");
    assert.equal(state.status, "权限模式: 绕过");

    // Toggle back to auto
    state = tuiReducer(state, { type: "TOGGLE_PERMISSION_MODE" });
    assert.equal(state.permissionMode, "auto");
    assert.equal(state.status, "权限模式: 自动");
  });

  it("preserves permission mode on RESET", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "TOGGLE_PERMISSION_MODE" });
    assert.equal(state.permissionMode, "plan");

    state = tuiReducer(state, { type: "RESET" });
    // Reset preserves permission mode
    assert.equal(state.permissionMode, "plan");
  });

  it("tracks and clears pending permission requests", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: {
        type: "permission_required",
        request: {
          id: "perm-1",
          sessionId: "tui_session",
          tool: "write",
          arguments: { path: "src/app.tsx" },
          risk: "high",
        },
      },
    });

    assert.deepEqual(state.pendingPermission, {
      requestId: "perm-1",
      sessionId: "tui_session",
      tool: "write",
      risk: "high",
    });
    assert.equal(state.status, "等待权限确认: write (high) [Enter 拒绝 / A 允许 / D 拒绝]");

    state = tuiReducer(state, { type: "CLEAR_PENDING_PERMISSION" });
    assert.equal(state.pendingPermission, undefined);
    assert.equal(state.status, "正在执行 write...");
  });

  it("resets busy state when an error occurs", () => {
    let state = createInitialState("test-model");
    // Start a turn (sets busy to true)
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "Do work" });
    assert.equal(state.busy, true);

    // Simulate an error event
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "error", message: "API key missing" },
    });

    // After error, busy should be reset to false so input is enabled again
    assert.equal(state.busy, false);
    assert.equal(state.status, "请求失败");
    assert.equal(state.messages[state.messages.length - 1]?.kind, "error");
  });
});
