import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activityPresentation,
  formatActivity,
  loadingGlyph,
  LOADING_FRAME_MS,
  STREAM_STALL_NOTICE_MS,
  STREAM_STALL_WARNING_MS,
} from "../src/tui/activity.ts";
import { createInitialState } from "../src/tui/state.ts";

describe("TUI activity presentation", () => {
  it("distinguishes first-response wait, reasoning, and answer streaming", () => {
    const state = { ...createInitialState("test-model"), busy: true, turnStartedAt: 1_000 };
    assert.equal(activityPresentation(state, { now: 2_500 })?.label, "Waiting for model…");

    state.streamingReasoning = "inspect context";
    state.lastStreamAt = 2_000;
    assert.equal(activityPresentation(state, { now: 2_500 })?.label, "Thinking…");

    state.streamingText = "final answer";
    assert.equal(activityPresentation(state, { now: 2_500 })?.label, "Responding…");
  });

  it("prioritizes retry, permission, and running tool stages", () => {
    const state = { ...createInitialState("test-model"), busy: true, status: "请求超时，正在重试 (1/1)" };
    assert.equal(activityPresentation(state)?.phase, "retrying");

    state.pendingPermission = { requestId: "p", sessionId: "s", tool: "bash", risk: "high" };
    assert.match(activityPresentation(state)?.label ?? "", /permission.*Bash/i);
    state.pendingPermission = undefined;
    state.status = "执行工具...";
    state.messages = [{ kind: "tool_call", id: "t", name: "read", args: "{}", rawArgs: {}, status: "running", startedAt: 0 }];
    assert.equal(activityPresentation(state)?.label, "Running Read…");
  });

  it("shows elapsed time, output size, queues, and stalled token streams", () => {
    const state = {
      ...createInitialState("test-model"),
      busy: true,
      streamingText: "hello world",
      turnStartedAt: 1_000,
      lastStreamAt: 2_000,
    };
    const waiting = activityPresentation(state, { now: 2_000 + STREAM_STALL_NOTICE_MS, queuedCount: 2 });
    assert.match(formatActivity(waiting!), /Waiting for response tokens.*6s.*tokens.*2 queued/);
    assert.equal(waiting?.stalled, false);
    assert.equal(activityPresentation(state, { now: 2_000 + STREAM_STALL_WARNING_MS })?.stalled, true);
  });

  it("uses stable one-column spinner glyphs", () => {
    assert.equal(loadingGlyph(0, 0), "·");
    assert.equal(loadingGlyph(LOADING_FRAME_MS, 0), "✢");
    assert.equal([...loadingGlyph(LOADING_FRAME_MS * 5, 0)].length, 1);
  });
});
