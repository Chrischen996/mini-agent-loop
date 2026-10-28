import assert from "node:assert/strict";
import { test } from "node:test";
import { SmoothScrollController, type SmoothScrollScheduler } from "../src/tui/smooth-scroll.ts";

class FakeScheduler implements SmoothScrollScheduler {
  private time = 0;
  private nextId = 0;
  private readonly tasks = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }

  request(callback: () => void): unknown {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.time + 16, callback });
    return id;
  }

  cancel(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  advance(milliseconds: number): void {
    const end = this.time + milliseconds;
    while (true) {
      const next = [...this.tasks.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.tasks.delete(next[0]);
      this.time = next[1].at;
      next[1].callback();
    }
    this.time = end;
  }
}

test("smooth scrolling eases by terminal rows and reverses from the current position", () => {
  const scheduler = new FakeScheduler();
  const renderedOffsets: number[] = [];
  let offset = 0;
  const scroll = new SmoothScrollController({
    getOffset: () => offset,
    getMaxOffset: () => 10,
    scrollTo: (next) => {
      offset = next;
      renderedOffsets.push(next);
    },
    scheduler,
  });

  scroll.scrollBy(8);
  assert.equal(offset, 0, "the first frame should begin the animation");
  scheduler.advance(48);
  assert.ok(offset > 0 && offset < 8, "the viewport should pass through intermediate rows");
  assert.ok(renderedOffsets.every(Number.isInteger), "terminal viewports use whole rows");

  scroll.scrollBy(-3);
  scheduler.advance(300);
  assert.equal(offset, 5, "opposite input should retarget the in-flight motion");

  scroll.scrollBy(20);
  scheduler.advance(300);
  assert.equal(offset, 10, "the animation should clamp at the current maximum");
  scroll.dispose();
});

test("external viewport changes cancel pending animation", () => {
  const scheduler = new FakeScheduler();
  let offset = 0;
  let maxOffset = 20;
  const scroll = new SmoothScrollController({
    getOffset: () => offset,
    getMaxOffset: () => maxOffset,
    scrollTo: (next) => { offset = next; },
    scheduler,
  });

  scroll.scrollBy(10);
  scheduler.advance(32);
  maxOffset = offset;
  scroll.sync(offset, true);
  scheduler.advance(300);
  assert.equal(offset, maxOffset, "shrinking the range should stop an unreachable target");

  maxOffset = 20;
  scroll.scrollBy(10);
  scheduler.advance(32);
  scroll.sync(2);
  offset = 2;
  scheduler.advance(300);
  assert.equal(offset, 2);

  scroll.scrollBy(10);
  scroll.jumpTo(0);
  scheduler.advance(300);
  assert.equal(offset, 0, "a deliberate jump should cancel pending motion");
  scroll.dispose();
});
