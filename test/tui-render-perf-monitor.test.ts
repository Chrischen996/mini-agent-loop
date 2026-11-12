import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatRenderReport,
  getRenderStats,
  recordFramePaint,
  recordRowRepaint,
  resetRenderStats,
  resolveSlowFrameThresholdFromEnv,
  setSlowFrameThreshold,
} from "../src/tui/perf-monitor.ts";
import { IncrementalTerminalRenderer } from "../src/tui/incremental-renderer.ts";

describe("render perf monitor", () => {
  it("counts frames, painted rows, and slow frames against the threshold", () => {
    resetRenderStats();
    setSlowFrameThreshold(200);
    recordFramePaint(5, 3);
    recordFramePaint(250, 10);
    recordFramePaint(40, 0);
    const stats = getRenderStats();
    assert.equal(stats.frames, 3);
    assert.equal(stats.paintedRows, 13);
    assert.equal(stats.slowFrames, 1);
    assert.equal(stats.maxFrameMs, 250);
    assert.equal(stats.lastSlowFrameMs, 250);
    assert.equal(stats.lastFrameMs, 40);
  });

  it("honors a custom slow-frame threshold", () => {
    resetRenderStats();
    setSlowFrameThreshold(50);
    try {
      recordFramePaint(60, 1);
      assert.equal(getRenderStats().slowFrames, 1);
    } finally {
      setSlowFrameThreshold(200);
    }
  });

  it("reads the threshold from MINI_AGENT_SLOW_FRAME_MS", () => {
    assert.equal(resolveSlowFrameThresholdFromEnv({ MINI_AGENT_SLOW_FRAME_MS: "120" }), 120);
    assert.equal(resolveSlowFrameThresholdFromEnv({ MINI_AGENT_SLOW_FRAME_MS: "abc" }), 200);
    assert.equal(resolveSlowFrameThresholdFromEnv({}), 200);
  });

  it("flags flicker when one physical row repaints repeatedly inside a window", () => {
    resetRenderStats();
    const base = 1_000_000;
    // 11 repaints stay below the threshold of 12.
    for (let index = 0; index < 11; index++) recordRowRepaint(7, base + index);
    // Window rotation without enough repaints: no suspect yet.
    recordRowRepaint(99, base + 2_000);
    assert.equal(getRenderStats().flickerSuspects, 0);
    // Rebuild a hot window: 12 repaints of row 3 inside one second, then rotate.
    for (let index = 0; index < 12; index++) recordRowRepaint(3, base + 10_000 + index);
    recordRowRepaint(99, base + 20_000);
    assert.ok(getRenderStats().flickerSuspects >= 1, "a 12x repainted row must be flagged");
  });

  it("formats a one-line report", () => {
    resetRenderStats();
    recordFramePaint(12, 2);
    const report = formatRenderReport();
    assert.match(report, /frames=1/);
    assert.match(report, /avg=12\.0ms/);
    assert.match(report, /rows=2/);
  });

  it("records frames painted through the incremental renderer", () => {
    resetRenderStats();
    const target = { rows: 10, columns: 40, write: () => true };
    const renderer = new IncrementalTerminalRenderer(target as never);
    renderer.renderRows(["a", "b"]);
    const stats = getRenderStats();
    assert.ok(stats.frames >= 1, "renderRows must record a frame");
    assert.ok(stats.paintedRows >= 2, "painted rows must be counted");
  });
});
