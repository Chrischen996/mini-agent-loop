import { randomUUID } from "node:crypto";
import type { GoalStore } from "./store.ts";
import {
  goalSnapshot,
  isUnfinished,
  validateObjective,
  validateTokenBudget,
  type GoalSnapshot,
  type GoalState,
  type GoalStatus,
} from "./types.ts";

export type GoalEvent = {
  type: "goal_updated";
  goal: GoalSnapshot | null;
  reason: "created" | "status_changed" | "usage" | "cleared" | "budget_limited" | "usage_limited";
};

export type GoalManagerOptions = {
  store: GoalStore;
  sessionId: string;
  /** Optional ceiling applied to explicit token budgets. */
  maxGoalTokenBudget?: number;
  onEvent?: (event: GoalEvent) => void;
};

export type GoalUpdateOutcome = {
  goal?: GoalState;
  rejected: boolean;
  message: string;
};

/**
 * Session-scoped goal service. All mutations are serialized through the store,
 * so concurrent tool calls and client commands cannot interleave state writes.
 */
export class GoalManager {
  private readonly store: GoalStore;
  private readonly sessionId: string;
  private readonly maxGoalTokenBudget?: number;
  private readonly onEvent?: (event: GoalEvent) => void;
  private pendingGoalCreated = false;
  /** True when a goal objective was edited in place during this turn. */
  private objectiveEditedDuringTurn = false;

  constructor(options: GoalManagerOptions) {
    this.store = options.store;
    this.sessionId = options.sessionId;
    this.maxGoalTokenBudget = options.maxGoalTokenBudget;
    this.onEvent = options.onEvent;
  }

  private emit(goal: GoalState | undefined, reason: GoalEvent["reason"]): void {
    this.onEvent?.({ type: "goal_updated", goal: goal ? goalSnapshot(goal) : null, reason });
  }

  async get(): Promise<{ raw: GoalState; snapshot: GoalSnapshot } | undefined> {
    const goal = await this.store.get(this.sessionId);
    return goal ? { raw: goal, snapshot: goalSnapshot(goal) } : undefined;
  }

  /** Initial status is emitted to clients only when a goal already exists. */
  async initialize(): Promise<void> {
    const goal = await this.store.get(this.sessionId);
    if (goal) this.emit(goal, "created");
  }

  /** Model-initiated creation. Fails when an unfinished goal already exists. */
  async createFromModel(objective: unknown, tokenBudget?: unknown): Promise<GoalState> {
    const text = validateObjective(objective);
    const budget = validateTokenBudget(tokenBudget, this.maxGoalTokenBudget);
    const created = await this.store.update(this.sessionId, (current) => {
      if (isUnfinished(current)) {
        throw new Error("cannot create a new goal because this thread has an unfinished goal; complete the existing goal first");
      }
      return this.newGoal(text, budget);
    });
    if (!created) throw new Error("failed to persist the new goal");
    this.pendingGoalCreated = true;
    this.emit(created, "created");
    return created;
  }

  /**
   * User/API-initiated set. Explicit user authorization can replace an
   * existing active goal (objective edit), resume a stopped goal, or pause it.
   */
  async setFromUser(input: {
    objective?: string;
    status?: GoalStatus;
    tokenBudget?: number | null;
    clear?: boolean;
  }): Promise<GoalState | undefined> {
    if (input.clear) {
      await this.store.clear(this.sessionId);
      this.emit(undefined, "cleared");
      return undefined;
    }
    const objective = input.objective === undefined ? undefined : validateObjective(input.objective);
    // An explicit null clears the budget; undefined keeps the stored value.
    const budget = input.tokenBudget === undefined
      ? undefined
      : validateTokenBudget(input.tokenBudget, this.maxGoalTokenBudget);
    const status = input.status;
    const updated = await this.store.update(this.sessionId, (current) => {
      const now = Date.now();
      if (objective !== undefined) {
        const objectiveEdited = current !== undefined && current.goalId !== undefined;
        const next: GoalState = {
          sessionId: this.sessionId,
          goalId: current?.goalId ?? randomUUID(),
          objective,
          status: status ?? "active",
          ...(budget !== undefined ? { tokenBudget: budget } : current?.tokenBudget !== undefined ? { tokenBudget: current.tokenBudget } : {}),
          tokensUsed: current?.tokensUsed ?? 0,
          timeUsedSeconds: current?.timeUsedSeconds ?? 0,
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
        };
        if (objectiveEdited) this.objectiveEditedDuringTurn = true;
        else this.pendingGoalCreated = true;
        return next;
      }
      if (!current) throw new Error("no goal exists for this thread");
      return {
        ...current,
        status: status ?? current.status,
        ...(input.tokenBudget === undefined ? {} : { tokenBudget: budget ?? undefined }),
        updatedAt: now,
      };
    });
    if (!updated && objective === undefined) throw new Error("no goal exists for this thread");
    this.emit(updated, "status_changed");
    return updated;
  }

  /**
   * Consume the pending steering intent for the next model call.
   * `created` fires for a freshly created goal, `edited` for an in-place
   * objective change; `undefined` when nothing changed since the last call.
   */
  takeSteeringIntent(): "created" | "edited" | undefined {
    if (this.pendingGoalCreated) {
      this.pendingGoalCreated = false;
      this.objectiveEditedDuringTurn = false;
      return "created";
    }
    if (this.objectiveEditedDuringTurn) {
      this.objectiveEditedDuringTurn = false;
      return "edited";
    }
    return undefined;
  }

  /** Model-initiated status change; only complete/blocked/paused are allowed. */
  async updateFromModel(status: string): Promise<GoalUpdateOutcome> {
    if (status !== "complete" && status !== "blocked" && status !== "paused") {
      return {
        rejected: true,
        message: "update_goal can only mark the existing goal complete, blocked, or paused at the user's explicit request; resume, budget-limited, and usage-limited status changes are controlled by the user or system",
      };
    }
    const updated = await this.store.update(this.sessionId, (current) => {
      if (!current) return undefined;
      return { ...current, status: status as GoalStatus, updatedAt: Date.now() };
    });
    if (!updated) return { rejected: true, message: "cannot update goal because this thread has no goal" };
    this.emit(updated, "status_changed");
    return { goal: updated, rejected: false, message: `Goal status: ${updated.status}` };
  }

  /** Add token and elapsed-time usage to the current active goal. */
  async accountUsage(tokensDelta: number, secondsDelta: number): Promise<GoalState | undefined> {
    const safeTokens = Number.isFinite(tokensDelta) ? Math.max(0, Math.floor(tokensDelta)) : 0;
    const safeSeconds = Number.isFinite(secondsDelta) ? Math.max(0, Math.floor(secondsDelta)) : 0;
    if (safeTokens === 0 && safeSeconds === 0) return undefined;
    const before = await this.store.get(this.sessionId);
    if (!before || before.status !== "active") return undefined;
    let updated: GoalState | undefined;
    await this.store.update(this.sessionId, (current) => {
      if (!current || current.status !== "active") return undefined;
      const tokensUsed = current.tokensUsed + safeTokens;
      const timeUsedSeconds = current.timeUsedSeconds + safeSeconds;
      const budgetReached = current.tokenBudget !== undefined && tokensUsed >= current.tokenBudget;
      updated = {
        ...current,
        tokensUsed,
        timeUsedSeconds,
        ...(budgetReached ? { status: "budget_limited" as const } : {}),
        updatedAt: Date.now(),
      };
      return updated;
    });
    // Only announce the budget-limit transition to clients; per-tick usage is
    // surfaced through snapshot callbacks, not the loop event stream.
    if (updated && updated.status === "budget_limited") {
      this.emit(updated, "budget_limited");
    }
    return updated;
  }

  private newGoal(objective: string, tokenBudget?: number): GoalState {
    const now = Date.now();
    return {
      sessionId: this.sessionId,
      goalId: randomUUID(),
      objective,
      status: "active",
      ...(tokenBudget !== undefined ? { tokenBudget } : {}),
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: now,
      updatedAt: now,
    };
  }
}
