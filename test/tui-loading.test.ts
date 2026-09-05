import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLAUDE_SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  createSpinnerTicker,
  getSpinnerFrame,
  loadingLabel,
} from "../src/tui/loading.ts";

describe("TUI loading presentation", () => {
  it("cycles through the Claude-style spinner frames", () => {
    assert.equal(getSpinnerFrame(0), CLAUDE_SPINNER_FRAMES[0]);
    assert.equal(getSpinnerFrame(CLAUDE_SPINNER_FRAMES.length), CLAUDE_SPINNER_FRAMES[0]);
    assert.equal(getSpinnerFrame(-1), CLAUDE_SPINNER_FRAMES.at(-1));
  });

  it("normalizes internal statuses into one loading label", () => {
    assert.equal(loadingLabel("思考中..."), "Thinking…");
    assert.equal(loadingLabel("任务列表已更新", "▶ Inspecting files"), "Inspecting files…");
    assert.equal(loadingLabel("read..."), "Working…");
  });

  it("advances a ticker only while it is running", () => {
    const frames: number[] = [];
    let tick: (() => void) | undefined;
    let cleared = 0;
    const ticker = createSpinnerTicker((frame) => frames.push(frame), {
      setInterval(callback, delay) {
        assert.equal(delay, SPINNER_INTERVAL_MS);
        tick = callback;
        return "timer";
      },
      clearInterval(handle) {
        assert.equal(handle, "timer");
        cleared += 1;
      },
    });

    ticker.start();
    ticker.start();
    assert.deepEqual(frames, [0]);
    tick?.();
    assert.deepEqual(frames, [0, 1]);

    ticker.stop();
    assert.equal(cleared, 1);
    ticker.stop();
    assert.equal(cleared, 1);

    ticker.reset();
    ticker.start();
    assert.equal(frames.at(-1), 0);
    ticker.stop();
  });
});
