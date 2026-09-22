// tui-core — FrameScheduler tests.
//
// Pins the coalescing contract: N `invalidate()` calls within one
// interval boundary produce exactly one `onFrame` paint, and
// `flushNow()` overrides the schedule. Uses fake timers via a manual
// setTimeout spy so the test is deterministic.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFrameScheduler } from "../src/tui/tui-core/frame-scheduler.ts";

class FakeTimer {
  private tasks: Map<number, { fn: () => void; at: number }> = new Map();
  private now = 0;
  private idCounter = 0;

  setTimeout(fn: () => void, ms: number): number {
    const id = ++this.idCounter;
    this.tasks.set(id, { fn, at: this.now + ms });
    return id;
  }

  clearTimeout(id: number): void {
    this.tasks.delete(id);
  }

  advance(ms: number): void {
    const target = this.now + ms;
    // Run due tasks in chronological order; a task may schedule more.
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((a, b) => a[1].at - b[1].at);
      if (due.length === 0) break;
      const [id, task] = due[0]!;
      this.now = task.at;
      this.tasks.delete(id);
      task.fn();
    }
    this.now = target;
  }
}

// The scheduler under test captures `setTimeout`/`clearTimeout` at
// construction time via the module's top-level references. To make the
// test deterministic we monkey-patch the globals *before* creating the
// scheduler, then restore them in teardown.
function withFakeTimers(body: (timer: FakeTimer) => void): void {
  const fake = new FakeTimer();
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = (fn: () => void, ms: number) => fake.setTimeout(fn, ms);
  (globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = (id: number) => fake.clearTimeout(id);
  try {
    body(fake);
  } finally {
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = originalSet;
    (globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = originalClear;
  }
}

describe("FrameScheduler", () => {
  it("coalesces N invalidates into one paint per interval", () => {
    withFakeTimers((fake) => {
      let paints = 0;
      const scheduler = createFrameScheduler(() => {
        paints += 1;
      }, { intervalMs: 16 });

      // 10 store dispatches within one 16ms window.
      for (let i = 0; i < 10; i += 1) scheduler.invalidate();
      assert.equal(scheduler.isDirty(), true);
      assert.equal(paints, 0, "no paint before the interval boundary");

      fake.advance(16);
      assert.equal(paints, 1, "exactly one paint after the interval");
      assert.equal(scheduler.isDirty(), false, "clean after the paint");

      // A second burst produces a second paint.
      scheduler.invalidate();
      fake.advance(16);
      assert.equal(paints, 2);
    });
  });

  it("flushNow paints immediately and cancels the pending frame", () => {
    withFakeTimers((fake) => {
      let paints = 0;
      const scheduler = createFrameScheduler(() => {
        paints += 1;
      }, { intervalMs: 16 });

      scheduler.invalidate();
      assert.equal(paints, 0);
      scheduler.flushNow();
      assert.equal(paints, 1, "flushNow paints immediately");
      assert.equal(scheduler.isDirty(), false);

      // flushNow clears the pending timer, but `dirty` is already false,
      // so advancing the (now empty) fake clock produces no further paint.
      fake.advance(16);
      assert.equal(paints, 1, "no double-paint after flushNow");

      // A new invalidate after flushNow schedules a fresh timer.
      scheduler.invalidate();
      assert.equal(paints, 1, "still no paint until the next boundary");
      fake.advance(16);
      assert.equal(paints, 2, "the rescheduled timer fires");
    });
  });

  it("dispose cancels any pending frame", () => {
    withFakeTimers((fake) => {
      let paints = 0;
      const scheduler = createFrameScheduler(() => {
        paints += 1;
      }, { intervalMs: 16 });

      scheduler.invalidate();
      scheduler.dispose();
      fake.advance(16);
      assert.equal(paints, 0, "no paint after dispose");
      // Invalidates after dispose are no-ops.
      scheduler.invalidate();
      fake.advance(16);
      assert.equal(paints, 0);
    });
  });

  it("non-coalescing mode paints on every invalidate", () => {
    withFakeTimers((fake) => {
      let paints = 0;
      const scheduler = createFrameScheduler(() => {
        paints += 1;
      }, { intervalMs: 16, coalesce: false });

      scheduler.invalidate();
      fake.advance(16);
      assert.equal(paints, 1);
      scheduler.invalidate();
      fake.advance(16);
      assert.equal(paints, 2, "each invalidate schedules its own flush");
    });
  });
});
