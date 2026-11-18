import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLAUDE_SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  BREATHING_PERIOD_MS,
  createSpinnerTicker,
  getSpinnerFrame,
  loadingLabel,
  breathingPhase,
  breathingColor,
  activityRowColor,
  mixHexColor,
  spinnerTipLabel,
} from "../src/tui/loading.ts";

describe("TUI loading presentation", () => {
  it("keeps the active-work marker visually stable", () => {
    assert.equal(getSpinnerFrame(0), CLAUDE_SPINNER_FRAMES[0]);
    assert.equal(getSpinnerFrame(CLAUDE_SPINNER_FRAMES.length), CLAUDE_SPINNER_FRAMES[0]);
    assert.equal(getSpinnerFrame(-1), CLAUDE_SPINNER_FRAMES.at(-1));
    assert.ok(CLAUDE_SPINNER_FRAMES.every((frame) => frame === CLAUDE_SPINNER_FRAMES[0]));
  });

  it("breathes with a smooth 0..1 intensity ramp", () => {
    // Dimmest at the period boundary, brightest at the midpoint.
    assert.equal(breathingPhase(0), 0);
    assert.equal(breathingPhase(BREATHING_PERIOD_MS), 0);
    assert.equal(breathingPhase(BREATHING_PERIOD_MS / 2), 1);
    // Continuous and monotonic up to the peak.
    assert.ok(breathingPhase(BREATHING_PERIOD_MS * 0.25) > breathingPhase(0));
    assert.ok(breathingPhase(BREATHING_PERIOD_MS * 0.25) < 1);
    assert.ok(breathingPhase(BREATHING_PERIOD_MS * 0.4) > breathingPhase(BREATHING_PERIOD_MS * 0.25));
    // Negative timestamps wrap forwards.
    assert.equal(breathingPhase(-BREATHING_PERIOD_MS / 2), 1);
    // Never leaves [0,1].
    for (let ms = 0; ms <= BREATHING_PERIOD_MS; ms += 137) {
      const p = breathingPhase(ms);
      assert.ok(p >= 0 && p <= 1, `phase out of range at ${ms}: ${p}`);
    }
  });

  it("interpolates hex colors for the breathing marker", () => {
    assert.equal(mixHexColor("#000000", "#ffffff", 0), "#000000");
    assert.equal(mixHexColor("#000000", "#ffffff", 1), "#ffffff");
    assert.equal(mixHexColor("#000000", "#ffffff", 0.5), "#808080");
    // Short hex is normalized.
    assert.equal(mixHexColor("#000", "#fff", 0.5), "#808080");
    // Named ANSI colors fall back to whichever endpoint is a usable hex.
    assert.equal(mixHexColor("red", "#ffc107", 0.5), "#ffc107");
    assert.equal(mixHexColor("#ffc107", "invalid", 0.5), "#ffc107");
  });

  it("derives a breathing color from phase and falls back gracefully", () => {
    const dark = "#111111";
    const accent = "#ffc107";
    assert.equal(breathingColor(accent, dark, 0), mixHexColor(dark, accent, 0));
    assert.equal(breathingColor(accent, dark, BREATHING_PERIOD_MS / 2), accent);
    assert.equal(breathingColor(accent, "non-color", BREATHING_PERIOD_MS / 2), accent);
  });

  it("breathes the whole activity row and preserves stall color", () => {
    const running = "#ffc107";
    const dim = "#111111";
    const error = "#ff0000";
    assert.equal(activityRowColor(running, dim, BREATHING_PERIOD_MS / 2), running);
    assert.equal(activityRowColor(running, dim, 0), dim);
    assert.equal(activityRowColor(running, dim, 0, true, error), error);
    assert.equal(activityRowColor(running, dim, BREATHING_PERIOD_MS / 2, true, error), error);
  });

  it("normalizes internal statuses into one loading label", () => {
    assert.equal(loadingLabel("思考中..."), "Thinking…");
    assert.equal(loadingLabel("任务列表已更新", "▶ Inspecting files"), "Inspecting files…");
    assert.equal(loadingLabel("read..."), "Working…");
  });

  it("normalizes a Todo tip into the shared spinner label", () => {
    assert.equal(spinnerTipLabel("▶ Writing tests"), "Writing tests…");
    assert.equal(spinnerTipLabel("Running checks…"), "Running checks…");
    assert.equal(spinnerTipLabel("   "), undefined);
    assert.equal(spinnerTipLabel(undefined), undefined);
    // The tip is the label of the single activity row, never a second spinner.
    assert.equal(loadingLabel("", "▶ Writing tests"), "Writing tests…");
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
