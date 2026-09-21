import type { ChatFn, LlmConfig } from "../llm/index.ts";
import type { PermissionManager, PermissionTurnContext } from "../permissions.ts";
import type { AgentMessage, MessageContent, ToolCall } from "../types.ts";
import type { MessagePreprocessor } from "../preprocessors/index.ts";
import type { ToolProvider, ToolResult } from "../tools/types.ts";
import type { RuntimeExecutionContext } from "../runtime/policy-types.ts";
import type { AutoSubagentOptions } from "../subagent/auto.ts";
import type { TuiStore } from "./state.ts";
import { TurnRunner, type TerminalTurnResult as _KernelTurnResult } from "./tui-core/turn-runner.ts";

export type TerminalAgentServiceOptions = {
  store: TuiStore;
  llm: LlmConfig;
  tools: ToolProvider;
  permissionManager: PermissionManager;
  permissionSessionId?: string;
  getPermissionSessionId?: () => string;
  history?: AgentMessage[];
  autoSubagent?: AutoSubagentOptions;
  preprocessors?: MessagePreprocessor[];
  runtimeRef?: import("../loop.ts").AgentRuntimeRef;
  runtimeContext?: RuntimeExecutionContext;
  globalTokenBudget?: number;
  cwd?: string;
  thinkingMode?: "fixed" | "adaptive";
  autoValidate?: boolean;
  autoCheckpoint?: boolean;
  skillNames?: string[];
  skillRegistry?: import("../skills/types.ts").SkillRegistry;
  sessionId?: string;
  chat?: ChatFn;
  onLlmChange?: (llm: LlmConfig) => void;
  onPermissionTurnChange?: (turn: PermissionTurnContext | undefined) => void;
  /** Persist the user message before the first model request. */
  onTurnStarted?: (result: { prompt: string; history: AgentMessage[] }) => void | Promise<void>;
  onTurnFinished?: (result: TerminalTurnResult) => void | Promise<void>;
};

export type TerminalSubmitOptions = {
  userContent?: MessageContent;
  displayText?: string;
  images?: import("./state.ts").ImageAttachment[];
};

export type TerminalTurnResult = {
  succeeded: boolean;
  history: AgentMessage[];
  errorMessage?: string;
};

/**
 * Owns the single mutable AgentMessage history for the standalone terminal
 * entrypoint. UI code only dispatches actions; it never reimplements the
 * agent loop or appends model/tool messages itself.
 *
 * P1: this is now a thin wrapper around the kernel `TurnRunner`
 * (src/tui/tui-core/turn-runner.ts). The public API is unchanged so the
 * existing call sites in terminal-main.ts keep working; the wrapper will
 * be deleted in P4 once both entrypoints are constructed through
 * `createAgentSession` directly.
 */
export class TerminalAgentService {
  private readonly runner: TurnRunner;

  constructor(options: TerminalAgentServiceOptions) {
    this.runner = new TurnRunner({
      store: options.store,
      llm: options.llm,
      tools: options.tools,
      permissionManager: options.permissionManager,
      ...(options.permissionSessionId !== undefined ? { permissionSessionId: options.permissionSessionId } : {}),
      ...(options.getPermissionSessionId !== undefined ? { getPermissionSessionId: options.getPermissionSessionId } : {}),
      ...(options.history !== undefined ? { history: options.history } : {}),
      ...(options.autoSubagent !== undefined ? { autoSubagent: options.autoSubagent } : {}),
      ...(options.preprocessors !== undefined ? { preprocessors: options.preprocessors } : {}),
      ...(options.runtimeRef !== undefined ? { runtimeRef: options.runtimeRef } : {}),
      ...(options.runtimeContext !== undefined ? { runtimeContext: options.runtimeContext } : {}),
      ...(options.globalTokenBudget !== undefined ? { globalTokenBudget: options.globalTokenBudget } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.thinkingMode !== undefined ? { thinkingMode: options.thinkingMode } : {}),
      ...(options.autoValidate !== undefined ? { autoValidate: options.autoValidate } : {}),
      ...(options.autoCheckpoint !== undefined ? { autoCheckpoint: options.autoCheckpoint } : {}),
      ...(options.skillNames !== undefined ? { skillNames: options.skillNames } : {}),
      ...(options.skillRegistry !== undefined ? { skillRegistry: options.skillRegistry } : {}),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.chat !== undefined ? { chat: options.chat } : {}),
      onLlmChange: options.onLlmChange,
      onPermissionTurnChange: options.onPermissionTurnChange,
      onTurnStarted: options.onTurnStarted,
      onTurnFinished: options.onTurnFinished,
    });
  }

  getHistory(): AgentMessage[] {
    return this.runner.getHistory();
  }

  getLlm(): LlmConfig {
    return this.runner.getLlm();
  }

  setLlm(llm: LlmConfig): void {
    this.runner.setLlm(llm);
  }

  getThinkingMode(): "fixed" | "adaptive" {
    return this.runner.getThinkingMode();
  }

  setThinkingMode(mode: "fixed" | "adaptive"): void {
    this.runner.setThinkingMode(mode);
  }

  getSkillNames(): string[] {
    return this.runner.getSkillNames();
  }

  setSkillNames(names: string[]): void {
    this.runner.setSkillNames(names);
  }

  resetHistory(mode?: import("../permissions.ts").PermissionMode): void {
    this.runner.resetHistory(mode ?? "plan");
  }

  replaceHistory(history: AgentMessage[]): void {
    this.runner.replaceHistory(history);
  }

  async recordDirectToolTurn(prompt: string, call: ToolCall, result: ToolResult): Promise<TerminalTurnResult> {
    return this.runner.recordDirectToolTurn(prompt, call, result);
  }

  setSessionId(sessionId: string): void {
    this.runner.setSessionId(sessionId);
  }

  isBusy(): boolean {
    return this.runner.isBusy();
  }

  async waitForIdle(): Promise<void> {
    return this.runner.waitForIdle();
  }

  getQueuedCount(): number {
    return this.runner.getQueuedCount();
  }

  submit(prompt: string, submitOptions: TerminalSubmitOptions = {}): Promise<TerminalTurnResult> {
    return this.runner.submit(prompt, submitOptions);
  }

  abort(): void {
    this.runner.abort();
  }

  resolvePermission(decision: "allow" | "deny"): boolean {
    return this.runner.resolvePermission(decision);
  }
}
