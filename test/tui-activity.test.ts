import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activityPresentation,
  formatActivity,
  loadingGlyph,
  LOADING_FRAME_MS,
  LOADING_GLYPHS,
  STREAM_STALL_NOTICE_MS,
  STREAM_STALL_WARNING_MS,
} from "../src/tui/activity.ts";
import { CLAUDE_SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "../src/tui/loading.ts";
import { terminalStringWidth } from "../src/tui/terminal-width.ts";
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
    // Both clients share one frame set: `activity.ts` must not keep a private
    // glyph list whose `·` frame collided with the `·` status separators.
    assert.deepEqual(LOADING_GLYPHS, CLAUDE_SPINNER_FRAMES);
    assert.equal(LOADING_FRAME_MS, SPINNER_INTERVAL_MS);
    assert.equal(loadingGlyph(0, 0), CLAUDE_SPINNER_FRAMES[0]);
    assert.equal(loadingGlyph(LOADING_FRAME_MS, 0), CLAUDE_SPINNER_FRAMES[1]);
    assert.equal(loadingGlyph(LOADING_FRAME_MS * (CLAUDE_SPINNER_FRAMES.length + 2), 0), CLAUDE_SPINNER_FRAMES[2]);
    for (const glyph of LOADING_GLYPHS) assert.equal(terminalStringWidth(glyph), 1);
    assert.ok(!(LOADING_GLYPHS as readonly string[]).includes("·"));
  });

  it("folds the Todo tip into the single activity row", () => {
    const state = { ...createInitialState("test-model"), busy: true, status: "", spinnerMessage: "▶ Inspecting files" };
    const activity = activityPresentation(state, { now: 0 });
    assert.equal(activity?.phase, "working");
    assert.equal(formatActivity(activity!), "Inspecting files…");
    // A more specific phase still wins over the tip.
    const streaming = activityPresentation({ ...state, streamingText: "answer" }, { now: 0 });
    assert.equal(streaming?.phase, "responding");
    assert.equal(streaming?.label, "Responding…");
  });
});
