// tui-core — L1 headless kernel entry point.
//
// Renderer-agnostic composition of `TuiStore` + `TurnRunner`. Every TUI
// client (pi-tui canonical, Ink transition, legacy) builds its session
// through `createAgentSession`; nothing above L1 may re-implement the
// agent loop.
//
// This module MUST NOT import React, Ink, pi-tui or any renderer.

export {
  bootstrapTui,
  buildRoleLlmConfigs,
  type TuiBootstrap,
  type TuiBootstrapOptions,
  type SubagentToolsWiring,
} from "./bootstrap.ts";
export {
  TurnRunner,
  type TerminalSubmitOptions,
  type TerminalTurnResult,
  type TurnRunnerOptions,
} from "./turn-runner.ts";
export {
  createInitialState,
  createTuiStore,
  type TuiStore,
  type TuiState,
  type TuiAction,
} from "../state.ts";
export {
  createInitialSlices,
  combineSlices,
  projectToSlices,
  slicedReducer,
  type Slices,
  type TranscriptSlice,
  type AgentsSlice,
  type TodosSlice,
  type PlanSlice,
  type PermissionSlice,
  type RuntimeSlice,
  type ViewSlice,
  type NoticesSlice,
} from "./store-slices.ts";
export {
  createFrameScheduler,
  type FrameScheduler,
  type FrameSchedulerOptions,
} from "./frame-scheduler.ts";
export {
  createCommandRegistry,
  type CommandContext,
  type CommandDef,
  type CommandRegistry,
  SLASH_COMMANDS,
  KNOWN_SLASH_COMMAND_NAMES,
  parseSlashCommand,
  parseUnknownSlashCommand,
  formatHelpNotice,
  commandUsageColumn,
} from "./commands.ts";
export { TurnEventBuffer, DEFAULT_STREAM_BUFFER_DELAY_MS } from "../stream-buffer.ts";

import { TurnRunner, type TerminalSubmitOptions, type TerminalTurnResult, type TurnRunnerOptions } from "./turn-runner.ts";
import { createInitialState, createTuiStore, type TuiStore, type TuiState, type TuiAction } from "../state.ts";
import type { AgentMessage, ToolCall } from "../../types.ts";
import type { ToolResult } from "../../tools/types.ts";
import type { LlmConfig } from "../../llm/index.ts";
import type { PermissionMode } from "../../permissions.ts";

export type AgentSessionOptions = {
  /** Pre-built store. When omitted, a fresh store is created from `initialModelName`. */
  store?: TuiStore;
  /** Model name seed for the fresh-store path. */
  initialModelName?: string;
  /** Pre-seed the runner's AgentMessage history (restored session). */
  history?: AgentMessage[];
} & Omit<TurnRunnerOptions, "store" | "history">;

export type AgentSession = {
  store: TuiStore;
  runner: TurnRunner;
  submit(prompt: string, options?: TerminalSubmitOptions): Promise<TerminalTurnResult>;
  abort(): void;
  /** Resolve a pending permission request from keyboard input. */
  resolvePermission(decision: "allow" | "deny"): boolean;
  /** Await the active turn's finalization hooks before shutdown. */
  waitForIdle(): Promise<void>;
  /** Convenience dispatch for client-side UI actions. */
  dispatch(action: TuiAction): void;
  getState(): TuiState;
  // ── Extended API surface (mirrors TurnRunner) ──────────────────────────
  getHistory(): AgentMessage[];
  getLlm(): LlmConfig;
  setLlm(llm: LlmConfig): void;
  getThinkingMode(): "fixed" | "adaptive";
  setThinkingMode(mode: "fixed" | "adaptive"): void;
  getSkillNames(): string[];
  setSkillNames(names: string[]): void;
  resetHistory(mode?: PermissionMode): void;
  replaceHistory(history: AgentMessage[]): void;
  recordDirectToolTurn(prompt: string, call: ToolCall, result: ToolResult): Promise<TerminalTurnResult>;
  setSessionId(sessionId: string): void;
  isBusy(): boolean;
  getQueuedCount(): number;
};

export function createAgentSession(options: AgentSessionOptions): AgentSession {
  const { store: explicitStore, initialModelName, history, ...runnerOptions } = options;
  const store = explicitStore ?? createTuiStore(createInitialState(initialModelName ?? ""));
  const runner = new TurnRunner({ ...runnerOptions, store, history });
  return {
    store,
    runner,
    submit: (prompt, submitOptions) => runner.submit(prompt, submitOptions),
    abort: () => runner.abort(),
    resolvePermission: (decision) => runner.resolvePermission(decision),
    waitForIdle: () => runner.waitForIdle(),
    dispatch: (action) => store.dispatch(action),
    getState: () => store.getState(),
    getHistory: () => runner.getHistory(),
    getLlm: () => runner.getLlm(),
    setLlm: (llm) => runner.setLlm(llm),
    getThinkingMode: () => runner.getThinkingMode(),
    setThinkingMode: (mode) => runner.setThinkingMode(mode),
    getSkillNames: () => runner.getSkillNames(),
    setSkillNames: (names) => runner.setSkillNames(names),
    resetHistory: (mode?) => runner.resetHistory(mode),
    replaceHistory: (hist) => runner.replaceHistory(hist),
    recordDirectToolTurn: (prompt, call, result) => runner.recordDirectToolTurn(prompt, call, result),
    setSessionId: (id) => runner.setSessionId(id),
    isBusy: () => runner.isBusy(),
    getQueuedCount: () => runner.getQueuedCount(),
  };
}
