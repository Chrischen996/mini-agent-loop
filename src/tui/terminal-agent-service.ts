import type { ChatFn, LlmConfig } from "../llm/index.ts";
import { LlmTimeoutError } from "../llm/retry.ts";
import {
  createAgentHistory,
  MaxTurnsExceededError,
  runAgentTurn,
  type AgentRuntimeRef,
  type LoopEvent,
} from "../loop.ts";
import { PermissionModeChangedError, type PermissionManager, type PermissionTurnContext } from "../permissions.ts";
import type { AgentMessage, MessageContent, ToolCall } from "../types.ts";
import type { MessagePreprocessor } from "../preprocessors/index.ts";
import type { ToolProvider, ToolResult } from "../tools/types.ts";
import type { RuntimeExecutionContext } from "../runtime/policy-types.ts";
import type { AutoSubagentOptions } from "../subagent/auto.ts";
import { TurnEventBuffer } from "./stream-buffer.ts";
import type { TuiAction, TuiStore } from "./state.ts";
import { resolveAtRefs } from "./at-refs-resolver.ts";
import { imageAttachmentToPart } from "./image-attachments.ts";

export type TerminalAgentServiceOptions = {
  store: TuiStore;
  llm: LlmConfig;
  tools: ToolProvider;
  permissionManager: PermissionManager;
  permissionSessionId: string;
  history?: AgentMessage[];
  autoSubagent?: AutoSubagentOptions;
  preprocessors?: MessagePreprocessor[];
  runtimeRef?: AgentRuntimeRef;
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
 */
export class TerminalAgentService {
  private history: AgentMessage[];
  private activeLlm: LlmConfig;
  private activeThinkingMode: "fixed" | "adaptive";
  private activeSessionId: string | undefined;
  private activeTurn: Promise<TerminalTurnResult> | undefined;
  private readonly queuedSubmissions: Array<{
    prompt: string;
    options: TerminalSubmitOptions;
    resolve: (result: TerminalTurnResult) => void;
  }> = [];
  private readonly options: TerminalAgentServiceOptions;
  private readonly streamBuffer: TurnEventBuffer;

  constructor(options: TerminalAgentServiceOptions) {
    this.options = options;
    this.activeLlm = options.llm;
    this.activeThinkingMode = options.thinkingMode ?? "fixed";
    this.activeSessionId = options.sessionId;
    this.history = options.history ?? createAgentHistory(undefined, options.permissionManager.getMode());
    this.streamBuffer = new TurnEventBuffer((event) => this.dispatch({ type: "LOOP_EVENT", event }));
  }

  getHistory(): AgentMessage[] {
    return this.history;
  }

  getLlm(): LlmConfig {
    return this.activeLlm;
  }

  setLlm(llm: LlmConfig): void {
    this.activeLlm = llm;
    this.options.onLlmChange?.(llm);
  }

  getThinkingMode(): "fixed" | "adaptive" {
    return this.activeThinkingMode;
  }

  setThinkingMode(mode: "fixed" | "adaptive"): void {
    this.activeThinkingMode = mode;
  }

  getSkillNames(): string[] {
    return [...(this.options.skillNames ?? [])];
  }

  setSkillNames(names: string[]): void {
    if (!this.options.skillNames) this.options.skillNames = [];
    this.options.skillNames.splice(0, this.options.skillNames.length, ...names);
  }

  resetHistory(mode = this.options.permissionManager.getMode()): void {
    this.history = createAgentHistory(undefined, mode);
  }

  replaceHistory(history: AgentMessage[]): void {
    this.history = history;
  }

  /**
   * Record a direct slash-tool invocation in the same history used by agent
   * turns. Direct tools do not ask the model for an assistant message, but a
   * synthetic tool call/result pair keeps `/resume` faithful to what the user
   * actually ran and lets the normal persistence hook save it.
   */
  async recordDirectToolTurn(prompt: string, call: ToolCall, result: ToolResult): Promise<TerminalTurnResult> {
    this.history = [
      ...this.history,
      { role: "user", content: prompt },
      { role: "assistant", content: "", toolCalls: [call] },
      {
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: result.content,
        ...(result.isError ? { isError: true } : {}),
      },
    ];
    const outcome: TerminalTurnResult = {
      succeeded: !result.isError,
      history: this.history,
      ...(result.isError ? { errorMessage: String(result.content) } : {}),
    };
    try {
      await this.options.onTurnFinished?.(outcome);
    } catch {
      // Persistence/finalization must not turn a completed direct tool into a
      // failed chat action.
    }
    return outcome;
  }

  setSessionId(sessionId: string): void {
    this.activeSessionId = sessionId;
  }

  isBusy(): boolean {
    return this.activeTurn !== undefined;
  }

  getQueuedCount(): number {
    return this.queuedSubmissions.length;
  }

  /** Submit one user turn; concurrent prompts are drained FIFO after the active turn. */
  submit(prompt: string, submitOptions: TerminalSubmitOptions = {}): Promise<TerminalTurnResult> {
    if (this.activeTurn) {
      return new Promise((resolve) => {
        this.queuedSubmissions.push({ prompt, options: submitOptions, resolve });
      });
    }
    const run = this.run(prompt, submitOptions);
    let tracked: Promise<TerminalTurnResult>;
    tracked = run.finally(() => {
      if (this.activeTurn !== tracked) return;
      this.activeTurn = undefined;
      const next = this.queuedSubmissions.shift();
      if (!next) return;
      this.submit(next.prompt, next.options).then(next.resolve, (error) => {
        next.resolve({ succeeded: false, history: this.history, errorMessage: error instanceof Error ? error.message : String(error) });
      });
    });
    this.activeTurn = tracked;
    return tracked;
  }

  abort(): void {
    this.abortController?.abort();
    const queued = this.queuedSubmissions.splice(0);
    for (const item of queued) item.resolve({ succeeded: false, history: this.history, errorMessage: "turn aborted" });
  }

  resolvePermission(decision: "allow" | "deny"): boolean {
    const pending = this.options.store.getState().pendingPermission;
    if (!pending) return false;
    const resolved = this.options.permissionManager.resolve(
      pending.sessionId,
      pending.requestId,
      decision,
    );
    if (resolved) this.dispatch({ type: "CLEAR_PENDING_PERMISSION" });
    return resolved;
  }

  private abortController?: AbortController;

  private dispatch(action: TuiAction): void {
    this.options.store.dispatch(action);
  }

  private async run(prompt: string, submitOptions: TerminalSubmitOptions): Promise<TerminalTurnResult> {
    const text = prompt.trim();
    if (!text) return { succeeded: false, history: this.history };
    const state = this.options.store.getState();
    if (state.busy) return { succeeded: false, history: this.history };

    this.dispatch({
      type: "USER_MESSAGE",
      text: prompt,
      ...(submitOptions.displayText !== undefined ? { displayText: submitOptions.displayText } : {}),
      ...(submitOptions.images?.length ? { images: submitOptions.images } : {}),
    });

    const abortController = new AbortController();
    this.abortController = abortController;
    const permissionTurn = this.options.permissionManager.beginTurn(
      this.options.permissionSessionId,
      (request) => this.dispatch({ type: "LOOP_EVENT", event: { type: "permission_required", request } }),
      abortController.signal,
    );
      this.options.onPermissionTurnChange?.(permissionTurn);
      const runId = this.streamBuffer.start();
    let currentPrompt = prompt;
    let userContent = submitOptions.userContent;
    let continueCount = 0;
    let succeeded = false;
    let errorMessage: string | undefined;
    let aborted = false;

    try {
      await this.options.onTurnStarted?.({
        prompt,
        history: [
          ...this.history,
          { role: "user", content: submitOptions.userContent ?? prompt },
        ],
      });
      if (userContent === undefined) {
        userContent = await resolveAtRefs(text, permissionTurn, this.options.tools);
      }
      if (submitOptions.images?.length) {
        const imageParts = await Promise.all(submitOptions.images.map((image) => imageAttachmentToPart(image)));
        const textParts = typeof userContent === "string"
          ? [{ type: "text" as const, text: userContent }]
          : userContent;
        userContent = [...textParts, ...imageParts];
      }
      while (true) {
        try {
          this.history = await runAgentTurn(this.history, currentPrompt, {
            llm: { ...this.activeLlm, ...(this.activeSessionId ? { sessionId: this.activeSessionId } : {}) },
            tools: this.options.tools,
            chat: this.options.chat,
            autoSubagent: this.options.autoSubagent,
            preprocessors: this.options.preprocessors,
            signal: abortController.signal,
            userContent,
            permissionTurn,
            runtimeRef: this.options.runtimeRef,
            runtimeContext: this.options.runtimeContext,
            globalTokenBudget: this.options.globalTokenBudget,
            thinkingMode: this.activeThinkingMode,
            autoValidate: this.options.autoValidate ?? false,
            validationWorkspace: this.options.cwd,
            autoCheckpoint: this.options.autoCheckpoint ?? false,
            skillNames: this.options.skillNames,
            skillRegistry: this.options.skillRegistry,
            onEvent: (event) => {
              if (event.type === "aborted") aborted = true;
              this.handleEvent(runId, event);
            },
          });
          succeeded = !aborted;
          break;
        } catch (error) {
          if (error instanceof MaxTurnsExceededError) {
            this.history = error.messages;
            continueCount += 1;
            const maxContinues = 5;
            if (continueCount >= maxContinues || abortController.signal.aborted) {
              if (abortController.signal.aborted) {
                this.emitTerminalEvent(runId, this.abortEvent(this.history, abortController.signal.reason));
                aborted = true;
              } else {
                errorMessage = `已达到自动续跑上限 (${maxContinues} 次)`;
                this.emitTerminalEvent(runId, { type: "error", message: errorMessage });
              }
              break;
            }
            currentPrompt = "继续完成之前的工作";
            userContent = currentPrompt;
            this.dispatch({ type: "AUTO_CONTINUE", count: continueCount, max: maxContinues });
            continue;
          }
          if (error instanceof LlmTimeoutError && error.messages) {
            this.history = error.messages;
            errorMessage = formatTimeout(error);
            this.emitTerminalEvent(runId, { type: "error", message: errorMessage });
            break;
          }
          if (error instanceof PermissionModeChangedError || abortController.signal.aborted) {
            aborted = true;
            this.emitTerminalEvent(runId, this.abortEvent(this.history, abortController.signal.reason));
            break;
          }
          errorMessage = error instanceof Error ? error.message : String(error);
          this.emitTerminalEvent(runId, { type: "error", message: errorMessage });
          break;
        }
      }
    } finally {
      this.streamBuffer.finish(runId);
      permissionTurn.close();
      this.options.onPermissionTurnChange?.(undefined);
      this.abortController = undefined;
      const result = { succeeded, history: this.history, ...(errorMessage ? { errorMessage } : {}) } satisfies TerminalTurnResult;
      try {
        await this.options.onTurnFinished?.(result);
      } catch {
        // Finalization hooks are bookkeeping and must not break the turn.
      }
      return result;
    }
  }

  private handleEvent(runId: number, event: LoopEvent): void {
    if (event.type === "thinking_policy") {
      const next = { ...this.activeLlm, thinkingLevel: event.level };
      this.activeLlm = next;
      this.options.onLlmChange?.(next);
    }
    // `runAgentTurn` emits terminal events itself. The service only forwards
    // them, so it must not synthesize a second completion event in finally.
    this.streamBuffer.handle(runId, event);
  }

  private emitTerminalEvent(runId: number, event: LoopEvent): void {
    this.streamBuffer.handle(runId, event);
  }

  private abortEvent(history: AgentMessage[], reason: unknown): Extract<LoopEvent, { type: "aborted" }> {
    if (reason instanceof PermissionModeChangedError) {
      return {
        type: "aborted",
        messages: history,
        reason: "permission_mode_changed",
        previousMode: reason.previousMode,
        permissionMode: reason.mode,
      };
    }
    return { type: "aborted", messages: history };
  }
}

function formatTimeout(error: LlmTimeoutError): string {
  const phase = error.phase === "first_response" ? "first response" : error.phase === "stream_idle" ? "stream idle" : error.phase === "total" ? "total request" : "request";
  const duration = error.timeoutMs === undefined ? "" : `, ${Math.ceil(error.timeoutMs / 1000)}s`;
  const preview = error.partialContent?.replace(/\s+/g, " ").trim().slice(0, 80);
  return preview
    ? `LLM timeout (${phase}${duration}) - partial response saved: ${preview}`
    : `LLM timeout (${phase}${duration}) - no partial response received`;
}
