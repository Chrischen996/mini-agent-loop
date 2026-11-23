import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInitialState, tuiReducer } from "../src/tui/state.ts";
import {
  buildSealedStaticItems,
  isSealableTranscriptMessage,
  MessageHeightCache,
} from "../src/tui/message-viewport.ts";

/**
 * The sealed/streaming split is the contract `useStreamBursts` relies on:
 * sealed rows are printed once into the scrollback and the frame starts after
 * them. These tests pin the pure builder it wraps, so a regression in the
 * split shows up without mounting Ink.
 */
function buildSealed(state: ReturnType<typeof createInitialState>, cache = new MessageHeightCache()) {
  return buildSealedStaticItems({
    messages: state.messages,
    width: 80,
    thinkingMode: state.thinkingMode,
    expandedThinking: state.expandedThinking,
    subagentById: state.subagentById,
    toolById: state.toolById,
    subagentRevision: state.subagentRevision,
    toolRevision: state.toolRevision,
    sealedSubagentCards: true,
    cache,
  });
}

describe("sealed static split (stream burst input)", () => {
  it("returns nothing to seal for an empty transcript", () => {
    const sealed = buildSealed(createInitialState("test-model"));
    assert.equal(sealed.sealedCount, 0);
    assert.deepEqual(sealed.items, []);
  });

  it("seals finalized messages and keeps a row snapshot for each", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "hello" });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "assistant", message: { role: "assistant", content: "hi there" } },
    });

    const sealed = buildSealed(state);
    assert.equal(sealed.sealedCount, state.messages.length, "finalized turns are fully sealable");
    assert.equal(sealed.items.length, sealed.sealedCount);
    for (const item of sealed.items) {
      assert.ok(item.rows.length > 0, "sealed items always carry rows");
    }
  });

  it("stops sealing at a running tool call so the live row stays in the frame", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "run the tests" });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: {
        type: "tool_start",
        call: { id: "call_1", name: "bash", arguments: { command: "npm test" } },
      },
    });

    const sealed = buildSealed(state);
    assert.ok(sealed.sealedCount < state.messages.length, "a running tool is never sealed");
    const running = state.messages.find(
      (message) => message.kind === "tool_call" && message.id === "call_1",
    );
    assert.ok(running, "the tool call is in the transcript");
    assert.equal(isSealableTranscriptMessage(running, {}, { sealedSubagentCards: true }), false);
  });

  it("never moves the seal boundary backwards across transcript growth", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "first" });
    const cache = new MessageHeightCache();
    const first = buildSealed(state, cache);

    state = tuiReducer(state, { type: "USER_MESSAGE", text: "second" });
    const second = buildSealed(state, cache);

    assert.ok(second.sealedCount >= first.sealedCount, "sealing is monotonic on append");
    // The cache must return identical row snapshots for already-sealed items.
    for (const item of first.items) {
      const again = second.items.find((candidate) => candidate.index === item.index);
      assert.ok(again, `item ${item.index} stays sealed`);
      assert.equal(again.rows, item.rows, "unchanged items reuse the cached row array");
    }
  });
});
