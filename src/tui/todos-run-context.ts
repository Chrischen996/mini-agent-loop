// Assembles the `TodosRunCommandContext` for AgentSessionApp's
// `/tasks run` runner, split out of the component's `runTodosCommand`.
//
// The inline body wired a store adapter (live state/dispatch through refs),
// session/permission/tool lookups, and the plan-confirmation handshake into
// one object literal. Keeping that assembly in a pure function makes the
// wiring testable without React (this project has no renderHook infra) and
// pins the subtle bits: the one-shot `subscribe` no-op, the fire-and-forget
// `recordSubmission`/`persistTodoState`, the live `clearInput` forwarder,
// and the confirmed-plan snapshot that the runner consumes exactly once.

import type { TuiAction, TuiState } from "./state.ts";
import type {
  TodosRunCommandContext,
  ParsedCommandArgs,
} from "./tui-core/commands.ts";
import type { TodosRunExecutors } from "./tui-core/command-runners.ts";
import type { PendingTodoRunPlan } from "./state.ts";
import type { ToolProvider } from "../tools/types.ts";
import type { PermissionManager } from "../permissions.ts";
import type { TodoItem } from "../todo.ts";
import type { SlashCommand } from "./slash-commands.ts";
export type TodosRunContextInput = {
  /** Live reducer state (read through `stateRef.current`). */
  getState: () => TuiState;
  /** Live dispatch (read through `dispatchRef.current`). */
  dispatch: (action: TuiAction) => void;
  /** Owning session id as of this call. */
  sessionId: string;
  permissionManager: PermissionManager;
  cwd: string;
  allTools: ToolProvider;
  abortSignal: AbortSignal;
  todosRunExecutors: TodosRunExecutors;
  /** Live input clear (the component's `setInputRef.current("")`). */
  clearInput: () => void;
  /** Stores the plan awaiting user confirmation and mirrors it to UI state. */
  onConfirmTodoRun: (pending: PendingTodoRunPlan) => void;
  /** True only when the user accepted the displayed plan. */
  todoRunConfirmed: boolean;
  /** Frozen todos snapshot from the confirmed plan (undefined otherwise). */
  todoRunSnapshot?: TodoItem[];
};

/**
 * Assemble the runner context exactly as the inline `runTodosCommand` did.
 * Pure: no React, no I/O of its own — every callback is either a ref
 * forwarder or the one-liner the component used to inline.
 */
export function buildTodosRunContext(input: TodosRunContextInput): TodosRunCommandContext {
  return {
    store: {
      getState: input.getState,
      dispatch: (action: TuiAction) => input.dispatch(action),
      // The component never subscribed to store changes; the runner only
      // needs the subscription API to exist.
      subscribe: () => () => undefined,
    },
    sessionRef: { current: input.sessionId },
    permissionManager: input.permissionManager,
    cwd: input.cwd,
    allTools: input.allTools,
    recordSubmission: (text) => void text,
    clearInput: input.clearInput,
    abortSignal: input.abortSignal,
    persistTodoState: (todos) => void todos,
    todosRunExecutors: input.todosRunExecutors,
    onConfirmTodoRun: input.onConfirmTodoRun,
    todoRunConfirmed: input.todoRunConfirmed,
    todoRunSnapshot: input.todoRunSnapshot,
  };
}

/** Args object the runner should execute: the confirmed plan's parsed args
 *  win over the raw slash-command args, matching
 *  `args: approvedPlan?.parsed ?? parsed.args`. */
export function resolveTodosRunArgs(
  approvedParsedArgs: Extract<SlashCommand, { cmd: "todos-run" }>["args"] | undefined,
  rawParsedArgs: Extract<SlashCommand, { cmd: "todos-run" }>["args"],
): Extract<ParsedCommandArgs, { cmd: "todos-run" }> {
  return { cmd: "todos-run", args: approvedParsedArgs ?? rawParsedArgs };
}
