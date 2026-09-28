// tui-core — store slices 对拍 test.
//
// Pins the P2 shape-contract invariant:
//
//   combineSlices(projectToSlices(state)) === state
//
// for every reachable TuiState (fields that hold `undefined` are omitted
// by convention, matching `createInitialState`'s shape), and that
// `slicedReducer` (which delegates to the monolithic `tuiReducer` until
// the 8 slice reducers are migrated out of state.ts) stays in lockstep
// with the monolith.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createInitialState,
  tuiReducer,
  type TuiAction,
  type TuiState,
} from "../src/tui/state.ts";
import {
  combineSlices,
  createInitialSlices,
  projectToSlices,
  slicedReducer,
} from "../src/tui/tui-core/store-slices.ts";

function initial(modelName = "test/model"): TuiState {
  return createInitialState(modelName);
}

/** Fields with a defined value, sorted. */
function presentKeys(state: TuiState): string[] {
  return Object.keys(state).filter((key) => state[key as keyof TuiState] !== undefined).sort();
}

function samePresentFields(label: string, a: TuiState, b: TuiState): void {
  const ka = presentKeys(a);
  const kb = presentKeys(b);
  assert.deepEqual(
    kb,
    ka,
    `${label}: present-field sets diverged\n  missing: ${ka.filter((k) => !kb.includes(k))}\n  extra:   ${kb.filter((k) => !ka.includes(k))}`,
  );
}

/**
 * Deep-compare two states field-by-field. Timestamp-bearing fields
 * (`startedAt`, `turnStartedAt`, `lastStreamAt`, subagent `startedAt`)
 * are `Date.now()` calls and differ by milliseconds between two
 * independent reducer runs; compare everything else exactly and only
 * assert the timestamp fields are numeric.
 */
const TIMESTAMP_FIELDS = new Set([
  "startedAt", "turnStartedAt", "lastStreamAt", "durationMs",
]);

function blankTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(blankTimestamps);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = TIMESTAMP_FIELDS.has(key) ? 0 : blankTimestamps(item);
    }
    return result;
  }
  return value;
}

/**
 * Deep-compare two states field-by-field. Timestamp-bearing fields
 * (`startedAt`, `turnStartedAt`, `lastStreamAt`) are `Date.now()` calls
 * and differ by milliseconds between two independent reducer runs; they
 * are blanked out before the comparison.
 */
function deepEqualValues(label: string, a: TuiState, b: TuiState): void {
  samePresentFields(label, a, b);
  for (const key of presentKeys(a)) {
    const va = a[key as keyof TuiState];
    const vb = b[key as keyof TuiState];
    if (va === vb) continue;
    const ja = JSON.stringify(blankTimestamps(va));
    const jb = JSON.stringify(blankTimestamps(vb));
    if (ja !== jb) {
      assert.fail(
        `${label}: field ${key} diverged\n  A: ${ja}\n  B: ${jb}`,
      );
    }
  }
}

describe("store slices shape contract", () => {
  it("projectToSlices + combineSlices is a lossless round-trip on the initial state", () => {
    const state = initial();
    const roundTripped = combineSlices(projectToSlices(state));
    deepEqualValues("initial round-trip", state, roundTripped);
  });

  it("createInitialSlices + combineSlices equals createInitialState", () => {
    const monolithic = initial();
    const sliced = combineSlices(createInitialSlices("test/model"));
    deepEqualValues("initial slices", monolithic, sliced);
  });

  it("the round-trip holds after a full turn (streaming + tool + done)", () => {
    let state = initial();
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "hi" });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "assistant_delta", text: "Hello", kind: "answer" },
    });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: {
        type: "tool_start",
        call: { id: "t-1", name: "read", arguments: { path: "a" } },
      },
    });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: {
        type: "tool_end",
        call: { id: "t-1", name: "read", arguments: { path: "a" } },
        result: { content: "ok" },
      },
    });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "assistant", message: { role: "assistant", content: "Hello" } },
    });
    state = tuiReducer(state, { type: "LOOP_EVENT", event: { type: "done", messages: [] } });

    const roundTripped = combineSlices(projectToSlices(state));
    deepEqualValues("post-turn round-trip", state, roundTripped);
  });
});

describe("store slices 对拍 (sliced vs monolithic reducer)", () => {
  function runBoth(stream: TuiAction[]): void {
    let monolithic = initial();
    let sliced = initial();
    for (const [i, action] of stream.entries()) {
      monolithic = tuiReducer(monolithic, action);
      sliced = slicedReducer(sliced, action);
      deepEqualValues(`action[${i}] ${action.type}`, monolithic, sliced);
    }
  }

  it("USER_MESSAGE + streaming deltas + assistant + done stay in lockstep", () => {
    runBoth([
      { type: "USER_MESSAGE", text: "hello" },
      { type: "LOOP_EVENT", event: { type: "assistant_delta", text: "Hello", kind: "answer" } },
      { type: "LOOP_EVENT", event: { type: "assistant_delta", text: " world", kind: "answer" } },
      {
        type: "LOOP_EVENT",
        event: { type: "assistant", message: { role: "assistant", content: "Hello world" } },
      },
      { type: "LOOP_EVENT", event: { type: "done", messages: [] } },
    ]);
  });

  it("tool_start + tool_end + done stay in lockstep", () => {
    runBoth([
      { type: "USER_MESSAGE", text: "run" },
      {
        type: "LOOP_EVENT",
        event: { type: "tool_start", call: { id: "t-1", name: "read", arguments: { path: "src/x.ts" } } },
      },
      {
        type: "LOOP_EVENT",
        event: {
          type: "tool_end",
          call: { id: "t-1", name: "read", arguments: { path: "src/x.ts" } },
          result: { content: "file body" },
        },
      },
      { type: "LOOP_EVENT", event: { type: "done", messages: [] } },
    ]);
  });

  it("permission + thinking + status + model + scroll actions stay in lockstep", () => {
    let monolithic = initial();
    let sliced = initial();
    const stream: TuiAction[] = [
      { type: "SET_PERMISSION_MODE", mode: "bypass" },
      { type: "TOGGLE_THINKING_MODE" },
      { type: "SET_STATUS", status: "working" },
      { type: "MODEL_CHANGED", modelName: "new-model" },
      { type: "SCROLL_TO_BOTTOM" },
    ];
    for (const [i, action] of stream.entries()) {
      monolithic = tuiReducer(monolithic, action);
      sliced = slicedReducer(sliced, action);
      deepEqualValues(`action[${i}] ${action.type}`, monolithic, sliced);
    }
    assert.equal(monolithic.permissionMode, sliced.permissionMode);
    assert.equal(monolithic.thinkingMode, sliced.thinkingMode);
    assert.equal(monolithic.modelName, sliced.modelName);
  });

  it("RESET resets both paths identically (modulo the monotonic todoRevision)", () => {
    let monolithic = initial();
    let sliced = initial();
    monolithic = tuiReducer(monolithic, { type: "USER_MESSAGE", text: "first" });
    sliced = slicedReducer(sliced, { type: "USER_MESSAGE", text: "first" });
    deepEqualValues("after USER_MESSAGE", monolithic, sliced);
    monolithic = tuiReducer(monolithic, { type: "RESET" });
    sliced = slicedReducer(sliced, { type: "RESET" });
    // `todoRevision` is a module-level monotonic counter (nextTodoRevision),
    // so the two independent call sites produce different values. Every
    // other field must agree; compare with todoRevision blanked out.
    const blank = (state: TuiState) => ({ ...state, todoRevision: 0 });
    deepEqualValues("after RESET (todoRevision blanked)", blank(monolithic), blank(sliced));
    assert.equal(monolithic.messages.length, 0);
    assert.equal(sliced.messages.length, 0);
    assert.ok(monolithic.todoRevision > 0);
    assert.ok(sliced.todoRevision > 0);
  });

  it("SUBAGENT_EVENT + TOGGLE_SUBAGENT_EXPAND stay in lockstep", () => {
    const runtime = {
      model: "faux",
      provider: "faux",
      baseUrl: "http://localhost",
      thinkingMode: "fixed" as const,
      modelSwitchSucceeded: false,
    };
    runBoth([
      { type: "USER_MESSAGE", text: "delegate" },
      {
        type: "SUBAGENT_EVENT",
        event: {
          type: "subagent_start",
          id: "sa-1",
          task: "research task",
          profile: "researcher",
          depth: 1,
          runtime,
        },
      },
      {
        type: "SUBAGENT_EVENT",
        event: {
          type: "subagent_end",
          id: "sa-1",
          result: "done",
          success: true,
          depth: 1,
          turns: 2,
          totalTokens: 400,
          runtime,
          autoDelegationInherited: false,
        },
      },
      { type: "TOGGLE_SUBAGENT_EXPAND", id: "sa-1" },
    ]);
  });
});
