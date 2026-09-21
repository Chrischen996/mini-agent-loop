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
export { TurnEventBuffer, DEFAULT_STREAM_BUFFER_DELAY_MS } from "../stream-buffer.ts";

import { TurnRunner, type TerminalSubmitOptions, type TerminalTurnResult, type TurnRunnerOptions } from "./turn-runner.ts";
import { createInitialState, createTuiStore, type TuiStore, type TuiState, type TuiAction } from "../state.ts";
import type { AgentMessage } from "../../types.ts";

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
  };
}
