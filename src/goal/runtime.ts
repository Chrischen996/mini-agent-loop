import type { AgentMessage } from "../types.ts";
import type { GoalManager } from "./manager.ts";
import {
  budgetLimitPrompt,
  continuationPrompt,
  goalCreatedPrompt,
  objectiveUpdatedPrompt,
} from "./steering.ts";
import { goalSnapshot, type GoalSnapshot, type GoalState } from "./types.ts";

export type GoalSteeringOptions = {
  /** Maximum automatic goal continuations per user submission. */
  maxContinuations?: number;
  /** Called when the active goal reaches a budget limit mid-turn. */
  onBudgetLimited?: (goal: GoalState) => void;
  /** Called when the goal state should be persisted/streamed to clients. */
  onGoalSnapshot?: (goal: GoalSnapshot | null) => void;
  /** Emit a loop event for goal state changes. */
  onGoalEvent?: (event: { type: "goal_updated"; goal: GoalSnapshot | null; reason: string }) => void;
};

const GOAL_CONTEXT_MARKER = "<codex_internal_context source=\"goal\">";

/**
 * Runtime controller for goal-driven turns. Owns steering injection and
 * continuation decisions; the caller owns invoking the agent loop.
 */
export class GoalRuntimeController {
  private readonly manager: GoalManager;
  private readonly maxContinuations: number;
  private readonly onBudgetLimited?: (goal: GoalState) => void;
  private readonly onGoalSnapshot?: (goal: GoalSnapshot | null) => void;
  /** Loop clients assign this to forward goal state changes as loop events. */
  onGoalEvent?: GoalSteeringOptions["onGoalEvent"];
  private accountingStartMs = 0;
  private continuationsUsed = 0;
  private continuationActive = false;
  /** Dedupe key for published goal snapshots. */
  private lastPublishedKey?: string;
  /** Last published reason, to dedupe repeated event emission. */
  private lastPublishedReason?: string;
  /** When the budget-limit steering has been reported this turn. */
  private budgetLimitReported = false;

  constructor(manager: GoalManager, options: GoalSteeringOptions = {}) {
    this.manager = manager;
    this.maxContinuations = options.maxContinuations ?? 50;
    this.onBudgetLimited = options.onBudgetLimited;
    this.onGoalSnapshot = options.onGoalSnapshot;
    if (options.onGoalEvent !== undefined) this.onGoalEvent = options.onGoalEvent;
  }

  private publish(goal: GoalState | undefined, reason: string): void {
    const snapshot = goal ? goalSnapshot(goal) : null;
    // Dedupe: only forward to the loop event stream when the meaningful fields
    // or the reason changed since the last emit. Usage ticks keep the local
    // snapshot callback fresh without spamming the NDJSON stream.
    const key = goal
      ? `${goal.goalId}:${goal.status}:${goal.tokensUsed}:${goal.timeUsedSeconds}:${goal.tokenBudget ?? ""}`
      : "null";
    this.onGoalSnapshot?.(snapshot);
    if (reason === "usage") return;
    if (key === this.lastPublishedKey && reason === this.lastPublishedReason) return;
    this.lastPublishedKey = key;
    this.lastPublishedReason = reason;
    this.onGoalEvent?.({ type: "goal_updated", goal: snapshot, reason });
  }

  /** Reset per-user-submission accounting. */
  beginTurn(): void {
    this.accountingStartMs = Date.now();
    this.continuationsUsed = 0;
    this.budgetLimitReported = false;
    this.continuationActive = false;
  }

  /** Charge per-response token usage reported by a completed assistant message. */
  async chargeTokens(usage: { totalTokens?: number; inputTokens?: number; outputTokens?: number } | undefined): Promise<boolean> {
    const reported = usage?.totalTokens ??
      ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0));
    if (!Number.isFinite(reported) || reported <= 0) return false;
    const delta = Math.floor(reported);
    const goal = await this.manager.get();
    if (!goal || goal.raw.status !== "active") return false;
    const updated = await this.manager.accountUsage(delta, 0);
    this.publish(updated, updated?.status === "budget_limited" ? "budget_limited" : "usage");
    if (updated?.status === "budget_limited" && !this.budgetLimitReported) {
      this.onBudgetLimited?.(updated);
      return true;
    }
    return false;
  }

  /** Charge wall-clock elapsed time at a safe boundary. */
  async chargeElapsed(): Promise<void> {
    if (this.accountingStartMs === 0) {
      this.accountingStartMs = Date.now();
      return;
    }
    const seconds = Math.max(0, Math.floor((Date.now() - this.accountingStartMs) / 1000));
    if (seconds <= 0) return;
    const updated = await this.manager.accountUsage(0, seconds);
    this.accountingStartMs = Date.now();
    this.publish(updated, "usage");
  }

  /**
   * Inject goal steering into the message history before a model call.
   * Steering is an internal user-context message, so it is pruned on the
   * next injection to keep the history bounded. The returned array may be
   * identical to the input when there is nothing to inject.
   */
  async prepareMessages(messages: AgentMessage[]): Promise<AgentMessage[]> {
    const goal = await this.manager.get();
    const current = goal?.raw;
    const pruned = pruneGoalContexts(messages);
    if (!current) return pruned;

    const intent = this.manager.takeSteeringIntent();
    if (intent === "created") {
      return appendGoalContext(pruned, goalCreatedPrompt(current));
    }
    if (intent === "edited") {
      return appendGoalContext(pruned, objectiveUpdatedPrompt(current));
    }

    if (current.status === "budget_limited" && !this.budgetLimitReported) {
      // Nudge the model to wrap up; only the first budget-limited turn.
      this.budgetLimitReported = true;
      this.onBudgetLimited?.(current);
      return appendGoalContext(pruned, budgetLimitPrompt(current));
    }

    if (this.continuationActive && current.status === "active") {
      this.continuationActive = false;
      return appendGoalContext(pruned, continuationPrompt(current));
    }
    return pruned;
  }

  /**
   * Decide whether an automatic continuation should start. The prompt is
   * internal steering only: the loop reuses the original user text with
   * `isContinuation: true`, so no duplicate prompt is appended. Continuations
   * stop when the goal leaves the active status or the continuation cap is hit.
   */
  async shouldContinue(): Promise<{ prompt: string; goal: GoalState; isContinuation: boolean } | undefined> {
    const goal = await this.manager.get();
    const current = goal?.raw;
    if (!current || current.status !== "active") return undefined;
    if (this.continuationsUsed >= this.maxContinuations) return undefined;
    this.continuationsUsed += 1;
    this.continuationActive = true;
    return {
      prompt: continuationPrompt(current),
      goal: current,
      isContinuation: this.continuationsUsed > 1,
    };
  }

  /** Mark the run as complete; charges remaining elapsed time once. */
  async finish(): Promise<void> {
    await this.chargeElapsed();
  }

  /** Whether the current goal is still active (drives in-loop stop decisions). */
  async isActive(): Promise<boolean> {
    const goal = await this.manager.get();
    return goal?.raw.status === "active";
  }
}

function isGoalContext(message: AgentMessage): boolean {
  return message.role === "user" &&
    typeof message.content === "string" &&
    message.content.startsWith(GOAL_CONTEXT_MARKER);
}

function pruneGoalContexts(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((message) => !isGoalContext(message));
}

function appendGoalContext(messages: AgentMessage[], text: string): AgentMessage[] {
  return [...messages, { role: "user", content: text }];
}
