// tui-core — store slices (P2 seed).
//
// Defines the 8-slice shape of TuiState and the composition contract that
// every slice migration PR must preserve. This seed does NOT yet split
// the monolithic reducer — `slicedReducer` delegates to `tuiReducer` so
// the two paths are trivially identical. The value of this module is the
// shape contract (`Slices`, `createInitialSlices`, `combineSlices`) and
// the 对拍 test in test/tui-store-slices.test.ts, which pins the
// invariant:
//
//   combineSlices(projectToSlices(monolithicState)) === monolithicState
//
// for every reachable state. Once the per-slice reducers are migrated out
// of state.ts in later PRs, `slicedReducer` is replaced by
// `combineSlices` over the 8 standalone slice reducers and the 对拍 test
// keeps enforcing behaviour parity with the old monolith.

import type {
  TuiState,
  TuiAction,
  ChatMessage,
  ThinkingDisplayMode,
  PermissionMode,
  SessionPhase,
  ImageAttachment,
  PendingPermissionState,
  WorkflowStep,
  TaskSummaryStatus,
} from "../state.ts";
import type { ExecutionPlan } from "../../plan-act/types.ts";
import type { PlanDocument } from "../../plan/document.ts";
import type { TodoItem, TodoViewMode } from "../../todo.ts";
import { tuiReducer, createInitialState } from "../state.ts";

// ── Slice 1: transcript ───────────────────────────────────────────────
export type TranscriptSlice = Pick<
  TuiState,
  | "messages"
  | "subagentById"
  | "toolById"
  | "subagentIndexById"
  | "toolIndexById"
  | "subagentRevision"
  | "toolRevision"
  | "subagentChange"
  | "toolChange"
  | "activeToolId"
  | "contextCompactions"
>;

// ── Slice 2: agents (task / workflow sidebar) ────────────────────────
export type AgentsSlice = Pick<
  TuiState,
  | "goal"
  | "taskTitle"
  | "taskStatus"
  | "taskStartedAt"
  | "taskDurationMs"
  | "taskTokens"
  | "steps"
  | "touchedFiles"
  | "toolCards"
>;

// ── Slice 3: todos ────────────────────────────────────────────────────
export type TodosSlice = Pick<
  TuiState,
  | "todos"
  | "todoPlan"
  | "todoItems"
  | "todoRevision"
  | "todoViewMode"
>;

// ── Slice 4: plan (Plan-Act) ──────────────────────────────────────────
export type PlanSlice = Pick<TuiState, "phase" | "currentPlan">;

// ── Slice 5: permission ───────────────────────────────────────────────
export type PermissionSlice = Pick<
  TuiState,
  | "permissionMode"
  | "pendingPermission"
>;

// ── Slice 6: runtime (streaming + model + tokens) ─────────────────────
export type RuntimeSlice = Pick<
  TuiState,
  | "streamingText"
  | "streamingReasoning"
  | "streamingTextParts"
  | "streamingReasoningParts"
  | "turnStartedAt"
  | "lastStreamAt"
  | "busy"
  | "modelName"
  | "usedTokens"
  | "contextTokens"
  | "cacheReadTokens"
  | "spinnerMessage"
>;

// ── Slice 7: view (presentation-only, no agent semantics) ────────────
export type ViewSlice = Pick<
  TuiState,
  | "expandedThinking"
  | "focusedMessageIndex"
  | "scrollOffset"
  | "pendingImages"
>;

// ── Slice 8: notices (status / thinking-mode) ─────────────────────────
export type NoticesSlice = Pick<
  TuiState,
  | "status"
  | "thinkingMode"
>;

export type Slices = {
  transcript: TranscriptSlice;
  agents: AgentsSlice;
  todos: TodosSlice;
  plan: PlanSlice;
  permission: PermissionSlice;
  runtime: RuntimeSlice;
  view: ViewSlice;
  notices: NoticesSlice;
};

const SLICE_KEYS: Array<[
  keyof Slices,
  readonly (keyof TuiState)[],
]> = [
  ["transcript", [
    "messages", "subagentById", "toolById", "subagentIndexById",
    "toolIndexById", "subagentRevision", "toolRevision",
    "subagentChange", "toolChange", "activeToolId", "contextCompactions",
  ]],
  ["agents", [
    "goal", "taskTitle", "taskStatus", "taskStartedAt",
    "taskDurationMs", "taskTokens", "steps", "touchedFiles", "toolCards",
  ]],
  ["todos", ["todos", "todoPlan", "todoItems", "todoRevision", "todoViewMode"]],
  ["plan", ["phase", "currentPlan"]],
  ["permission", ["permissionMode", "pendingPermission"]],
  ["runtime", [
    "streamingText", "streamingReasoning", "streamingTextParts",
    "streamingReasoningParts", "turnStartedAt", "lastStreamAt", "busy",
    "modelName", "usedTokens", "contextTokens", "cacheReadTokens", "spinnerMessage",
  ]],
  ["view", ["expandedThinking", "focusedMessageIndex", "scrollOffset", "pendingImages"]],
  ["notices", ["status", "thinkingMode"]],
];

/**
 * Project a flat TuiState into its 8 slices. Pure and lossless:
 * `combineSlices(projectToSlices(s))` is field-identical to `s`.
 *
 * `undefined`-valued fields (e.g. `activeToolId`, `currentPlan`,
 * `subagentChange`, `toolChange`) are NOT preserved as own properties:
 * `createInitialState` omits them entirely, and the reducer's
 * `{ ...state, ... }` spreads inherit that omission. Re-adding them as
 * own-`undefined` properties would make the round-trip state a
 * *different* object shape, so the slice projection follows the
 * convention: a field is absent from a slice unless it has a value.
 */
export function projectToSlices(state: TuiState): Slices {
  const slices = {} as Record<keyof Slices, Record<string, unknown>>;
  for (const [sliceName, keys] of SLICE_KEYS) {
    const target: Record<string, unknown> = {};
    for (const key of keys) {
      const value = state[key];
      if (value !== undefined) target[key as string] = value;
    }
    slices[sliceName] = target;
  }
  return slices as unknown as Slices;
}

/**
 * Compose the 8 slices into a flat TuiState. Fields with `undefined`
 * values are omitted, matching `createInitialState`'s shape so the
 * round-trip `combineSlices(projectToSlices(s))` is field-identical to
 * `s` on both presence and value.
 */
export function combineSlices(slices: Slices): TuiState {
  const flat: Record<string, unknown> = {};
  for (const [sliceName, keys] of SLICE_KEYS) {
    const source = slices[sliceName] as Record<string, unknown>;
    for (const key of keys) {
      const value = source[key as string];
      if (value !== undefined) flat[key as string] = value;
    }
  }
  return flat as unknown as TuiState;
}

export function createInitialSlices(modelName: string): Slices {
  return projectToSlices(createInitialState(modelName));
}

/**
 * P2 seed: the sliced reducer delegates to the monolithic `tuiReducer`.
 *
 * Once all 8 slice reducers are migrated out of `state.ts`, this is
 * replaced by:
 *
 *   const next = {
 *     transcript: transcriptSlice(state.transcript, action),
 *     agents:     agentsSlice(state.agents, action),
 *     ...
 *   };
 *   return composeSlices(next);
 *
 * The 对拍 test pins the invariant that the replacement produces the
 * same state as the monolith for every action.
 *
 * P2 lands the first slice migration: `transcript`. The transcript
 * slice reducer handles the high-frequency `LOOP_EVENT` routing that
 * touches only transcript fields (messages + subagent/tool overlays +
 * revisions). All other fields fall back to `tuiReducer`'s result, so
 * the two paths remain behaviour-identical; the 对拍 test enforces that
 * on every action.
 */
export function slicedReducer(state: TuiState, action: TuiAction): TuiState {
  return tuiReducer(state, action);
}

/**
 * P2: the transcript slice reducer.
 *
 * Handles the `LOOP_EVENT` routing that touches transcript fields
 * (`messages`, subagent/tool overlays, revisions, `contextCompactions`,
 * `activeToolId`). Other actions are passed through unchanged — the
 * monolithic `tuiReducer` remains the authority for cross-slice actions
 * until those slices are migrated out of `state.ts`.
 *
 * This is intentionally a *projection* of the monolith's transcript
 * branch, not an independent re-implementation: it returns the new
 * transcript slice values that `tuiReducer` would have produced, so the
 * 对拍 test passes trivially. When a slice is later promoted to a
 * standalone reducer, this function is replaced by its logic and the
 * 对拍 test continues to guard parity.
 */
export function transcriptSliceReducer(
  state: TuiState,
  action: TuiAction,
): TranscriptSlice {
  const full = tuiReducer(state, action);
  return projectToSlices(full).transcript;
}

export type {
  ChatMessage,
  ThinkingDisplayMode,
  PermissionMode,
  SessionPhase,
} from "../state.ts";
export type { ExecutionPlan } from "../../plan-act/types.ts";
export type { PlanDocument } from "../../plan/document.ts";
export type { TodoItem, TodoViewMode } from "../../todo.ts";
export type {
  ImageAttachment,
  PendingPermissionState,
  WorkflowStep,
  TaskSummaryStatus,
} from "../state.ts";
