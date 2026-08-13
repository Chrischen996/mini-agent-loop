import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_STREAM_BUFFER_DELAY_MS, TurnEventBuffer } from "../src/tui/stream-buffer.ts";
import type { LoopEvent } from "../src/loop.ts";

describe("TurnEventBuffer", () => {
  it("batches streamed reasoning deltas with the default redraw window", () => {
    const events: LoopEvent[] = [];
    const buffer = new TurnEventBuffer((event) => events.push(event));
    const runId = buffer.start();

    buffer.handle(runId, { type: "assistant_delta", kind: "reasoning", text: "r1" });
    buffer.handle(runId, { type: "assistant_delta", kind: "reasoning", text: "r2" });

    assert.equal(DEFAULT_STREAM_BUFFER_DELAY_MS, 80);
    assert.equal(events.length, 0);
    buffer.handle(runId, { type: "done", messages: [] });
    const delta = events[0];
    assert.equal(delta?.type, "assistant_delta");
    assert.equal(delta && delta.type === "assistant_delta" ? delta.text : "", "r1r2");
    assert.equal(events[1]?.type, "done");
  });

  it("preserves reasoning and answer boundaries before terminal events", () => {
    const events: LoopEvent[] = [];
    const buffer = new TurnEventBuffer((event) => events.push(event), 1_000);
    const runId = buffer.start();

    buffer.handle(runId, { type: "assistant_delta", kind: "reasoning", text: "r1" });
    buffer.handle(runId, { type: "assistant_delta", kind: "reasoning", text: "r2" });
    buffer.handle(runId, { type: "assistant_delta", kind: "answer", text: "a1" });
    buffer.handle(runId, { type: "done", messages: [] });

    assert.deepEqual(events.map((event) => event.type), ["assistant_delta", "assistant_delta", "done"]);
    assert.deepEqual(events.slice(0, 2).map((event) => event.type === "assistant_delta" ? [event.kind, event.text] : []), [
      ["reasoning", "r1r2"],
      ["answer", "a1"],
    ]);
    assert.equal(buffer.isActive(runId), false);
  });

  it("drops buffered output after a run finishes and ignores its late timer", async () => {
    const events: LoopEvent[] = [];
    const buffer = new TurnEventBuffer((event) => events.push(event), 5);
    const firstRun = buffer.start();
    buffer.handle(firstRun, { type: "assistant_delta", kind: "reasoning", text: "stale" });
    buffer.finish(firstRun);

    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(events.length, 0);

    const secondRun = buffer.start();
    buffer.handle(secondRun, { type: "assistant_delta", kind: "answer", text: "fresh" });
    buffer.handle(secondRun, { type: "done", messages: [] });
    assert.deepEqual(events.map((event) => event.type), ["assistant_delta", "done"]);
    assert.equal((events[0] as Extract<LoopEvent, { type: "assistant_delta" }>).text, "fresh");
  });
});
