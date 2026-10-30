import {
  MaxTurnsExceededError,
  RunStoppedError,
  runAgentTurn,
  type AgentBudgetUsage,
  type AgentRunPolicy,
  type AgentRuntimeRef,
  type AgentTurnOptions,
  type CheckpointContext,
  type LoopEvent,
  type StopReason,
} from "../loop.ts";
import { PermissionModeChangedError } from "../permissions.ts";
import type { AgentMessage } from "../types.ts";
import type { WebRunBudgetUsage, WebRunReason, WebRunState } from "../session-store.ts";
import type { ContinueBudgetMode } from "./run-policy.ts";

export const DEFAULT_MAX_AUTO_CONTINUES = 5;

export type AutoContinueEvent = {
  type: "auto_continue";
  attempt: number;
  maxAutoContinues: number;
  messageCount: number;
  message?: string;
};

export type ServerTurnOptions = {
  loop: AgentTurnOptions;
  maxAutoContinues?: number;
  /** Persist the updated messages and runState. Calls are serialized. */
  persistCheckpoint: (messages: AgentMessage[], state: WebRunState) => Promise<void>;
  onAutoContinue?: (event: AutoContinueEvent) => void;
  runId?: string;
  isResume?: boolean;
  startRunning?: boolean;
  runPolicy?: AgentRunPolicy;
  previousRunState?: WebRunState | null;
  budgetMode?: ContinueBudgetMode;
};

function usage(value?: WebRunBudgetUsage): AgentBudgetUsage {
  return {
    tokensUsed: value?.tokensUsed ?? 0,
    toolCallsUsed: value?.toolCallsUsed ?? 0,
    writeCallsUsed: value?.writeCallsUsed ?? 0,
    elapsedMs: value?.elapsedMs ?? 0,
  };
}

function stopReason(reason?: StopReason): WebRunReason {
  if (reason === "cancelled") return "user_stop";
  if (reason === "failed") return "model_error";
  if (!reason || reason === "completed") return "step_limit";
  return reason;
}

/** Web policy execution, with bounded blocks retained for explicit maxTurns callers. */
export async function runServerAgentTurn(
  history: AgentMessage[],
  prompt: string,
  options: ServerTurnOptions,
): Promise<AgentMessage[]> {
  const {
    loop, persistCheckpoint, onAutoContinue,
    runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    isResume = false, startRunning = false, runPolicy,
    previousRunState, budgetMode = "new",
  } = options;
  const maxAutoContinues = runPolicy ? 0 : options.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES;
  // Blocks stay bounded for legacy callers. The default is the safety cap, never a displayed 80.
  const maxTurnsPerBlock = runPolicy?.emergencyIterationCap ?? loop.maxTurns ?? 2000;
  const totalMaxSteps = maxTurnsPerBlock * (maxAutoContinues + 1);
  const initialUsage = usage(budgetMode === "remaining" ? previousRunState?.budgetUsage : undefined);
  const previousTotal = usage(previousRunState?.cumulativeBudgetUsage ?? previousRunState?.budgetUsage);
  const cumulativeBase = Object.fromEntries(Object.keys(previousTotal).map((key) => {
    const field = key as keyof AgentBudgetUsage;
    return [field, Math.max(0, previousTotal[field] - initialUsage[field])];
  })) as AgentBudgetUsage;
  let tokensUsed = initialUsage.tokensUsed;
  let toolCallsUsed = initialUsage.toolCallsUsed;
  let writeCallsUsed = initialUsage.writeCallsUsed;
  const startedAt = Date.now();
  const currentUsage = (): AgentBudgetUsage => ({
    tokensUsed, toolCallsUsed, writeCallsUsed,
    elapsedMs: initialUsage.elapsedMs + Date.now() - startedAt,
  });
  const cumulativeUsage = (current: AgentBudgetUsage): AgentBudgetUsage => ({
    tokensUsed: cumulativeBase.tokensUsed + current.tokensUsed,
    toolCallsUsed: cumulativeBase.toolCallsUsed + current.toolCallsUsed,
    writeCallsUsed: cumulativeBase.writeCallsUsed + current.writeCallsUsed,
    elapsedMs: cumulativeBase.elapsedMs + current.elapsedMs,
  });
  const writeToolNames = new Set(["write", "edit", "delete", "mkdir", "copy", "move", "patch", "document_edit"]);
  const runtimeRef: AgentRuntimeRef = loop.runtimeRef ?? {};
  let stepsAccumulated = 0;
  let checkpointRevision = previousRunState?.checkpointRevision ?? 0;
  let lastFingerprint = previousRunState?.lastFingerprint;
  let currentRunState: WebRunState | undefined;
  let persistenceFailed = false;
  let currentHistory = history;
  let currentPrompt = prompt;

  const saveState = async (
    messages: AgentMessage[], status: WebRunState["status"],
    reason?: WebRunReason, extraSteps = 0, details?: string,
  ): Promise<void> => {
    const budgetUsage = currentUsage();
    const state: WebRunState = {
      runId, status, reason, details,
      stepsUsed: stepsAccumulated + extraSteps, maxSteps: totalMaxSteps,
      budgetUsage, cumulativeBudgetUsage: cumulativeUsage(budgetUsage),
      budgetPolicy: runPolicy, budgetMode, lastFingerprint,
      checkpointRevision: ++checkpointRevision, savedAt: Date.now(),
    };
    if (persistenceFailed) throw new Error("Checkpoint persistence already failed");
    try {
      await persistCheckpoint(messages, state);
    } catch (error) {
      persistenceFailed = true;
      throw error;
    }
    currentRunState = state;
  };
  if (isResume || startRunning) await saveState(currentHistory, "running");

  for (let attempt = 0; attempt <= maxAutoContinues; attempt++) {
    // A resumed run continues the transcript that a previous run already
    // delivered, so its prompt must not be appended a second time. The
    // auto-continue nudge assigns `currentPrompt`, and that message is
    // meant to reach the model, so later attempts keep appending it.
    const isContinuation = attempt > 0 ? !currentPrompt : isResume;
    let blockTurnCount = 0;
    let terminalEvent: Extract<LoopEvent, { type: "done" | "aborted" }> | undefined;
    let messages: AgentMessage[];
    try {
      messages = await runAgentTurn(currentHistory, currentPrompt, {
        ...loop, runtimeRef, isContinuation, runPolicy,
        initialBudgetUsage: runPolicy ? initialUsage : undefined,
        maxTurns: runPolicy ? maxTurnsPerBlock : undefined,
        blockTurns: runPolicy ? undefined : maxTurnsPerBlock,
        llm: attempt > 0 ? runtimeRef.llm ?? loop.llm : loop.llm,
        context: attempt > 0 ? runtimeRef.context ?? loop.context : loop.context,
        autoSubagent: attempt > 0 ? undefined : loop.autoSubagent,
        userContent: isContinuation ? undefined : loop.userContent,
        onCheckpoint: async (ctx: CheckpointContext) => {
          if (ctx.turn !== undefined) blockTurnCount = Math.max(blockTurnCount, ctx.turn);
          if (ctx.lastFingerprint) lastFingerprint = ctx.lastFingerprint;
          let status: WebRunState["status"] = "running";
          let reason: WebRunReason | undefined;
          if (ctx.reason === "completed") status = "completed";
          else if (ctx.reason === "paused") {
            status = "paused";
            reason = stopReason(ctx.stopReason);
          } else if (ctx.reason === "interrupted") {
            status = "interrupted";
            reason = loop.signal?.aborted ? "user_stop" : "disconnected";
          } else if (ctx.reason === "failed") {
            status = "failed";
            reason = "model_error";
          }
          await saveState(ctx.messages, status, reason, blockTurnCount, ctx.details);
        },
        onEvent: (event) => {
          if (event.type === "assistant") tokensUsed += event.usage?.totalTokens ?? 0;
          else if (event.type === "tool_start") {
            toolCallsUsed += 1;
            if (writeToolNames.has(event.call.name)) writeCallsUsed += 1;
          }
          if (event.type === "done" || event.type === "aborted") terminalEvent = event;
          else if (event.type === "run_stopped") {
            // The core emits this only after the paused checkpoint is durable.
            loop.onEvent?.({
              ...event, budgetUsage: usage(currentRunState?.budgetUsage),
              cumulativeBudgetUsage: usage(currentRunState?.cumulativeBudgetUsage), budgetPolicy: runPolicy,
            });
          } else if (event.type !== "max_turns") loop.onEvent?.(event);
        },
      });
      if (!runPolicy && !terminalEvent && blockTurnCount >= maxTurnsPerBlock) {
        throw new MaxTurnsExceededError(messages, maxTurnsPerBlock);
      }
    } catch (error) {
      if (persistenceFailed) throw error;
      const partial = error instanceof MaxTurnsExceededError || error instanceof RunStoppedError
        ? error.messages : runtimeRef.history ?? [...currentHistory];
      if (error instanceof RunStoppedError) {
        if (currentRunState?.status !== "paused") {
          await saveState(partial, "paused", stopReason(error.stopReason), blockTurnCount, error.details);
        }
        throw error;
      }
      if (!(error instanceof MaxTurnsExceededError)) {
        const aborted = [loop.permissionTurn?.signal, loop.signal].some((s) => s?.aborted);
        const status = aborted ? "interrupted" : "failed";
        if (currentRunState?.status !== status) {
          await saveState(partial, status, aborted ? "user_stop" : "model_error", blockTurnCount);
        }
        throw error;
      }
      stepsAccumulated += blockTurnCount;
      const abortedSignal = [loop.permissionTurn?.signal, loop.signal].find((s) => s?.aborted);
      if (abortedSignal) {
        await saveState(partial, "interrupted", "user_stop");
        const reason: unknown = abortedSignal.reason;
        loop.onEvent?.({
          type: "aborted", messages: partial,
          ...(reason instanceof PermissionModeChangedError ? {
            reason: "permission_mode_changed" as const, previousMode: reason.previousMode, permissionMode: reason.mode,
          } : {}),
        });
        return partial;
      }
      if (attempt === maxAutoContinues) {
        const details = `Safety cap reached (${totalMaxSteps} steps); progress saved. Use Continue to resume.`;
        await saveState(partial, "paused", "safety_cap_reached", 0, details);
        const stopped = new RunStoppedError(partial, "safety_cap_reached", details);
        loop.onEvent?.({
          type: "run_stopped", stopReason: "safety_cap_reached", details, message: details, messages: partial,
        });
        throw stopped;
      }
      await saveState(partial, "running");
      onAutoContinue?.({
        type: "auto_continue",
        attempt: attempt + 1,
        maxAutoContinues,
        messageCount: partial.length,
        message: "Turn limit reached, continuing...",
      });
      currentHistory = partial;
      currentPrompt = "Continue the remaining work.";
      continue;
    }
    const status = terminalEvent?.type === "aborted" ? "interrupted" : "completed";
    if (currentRunState?.status !== status) {
      await saveState(messages, status, status === "interrupted" ? "user_stop" : undefined, blockTurnCount);
    }
    if (terminalEvent) loop.onEvent?.(terminalEvent);
    return messages;
  }
  throw new Error("Unreachable server turn state");
}
