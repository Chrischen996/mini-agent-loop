/**
 * Persisted, thread-scoped goal state. Mirrors the Codex `ThreadGoal` contract:
 * one goal per session, an explicit objective, status, optional token budget,
 * and accumulated token/time usage.
 */
export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete";

export type GoalState = {
  sessionId: string;
  goalId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

/** Public snapshot returned by get_goal, update_goal and the HTTP API. */
export type GoalSnapshot = Omit<GoalState, "goalId"> & {
  goalId: string;
  remainingTokens?: number;
};

export const GOAL_STATUSES: readonly GoalStatus[] = [
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
  "complete",
];

/** Statuses the model may set through `update_goal`. */
export const MODEL_GOAL_STATUSES: readonly GoalStatus[] = ["complete", "blocked", "paused"];

export const GOAL_OBJECTIVE_MAX_CHARS = 4_000;

export function isGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === "string" && (GOAL_STATUSES as readonly string[]).includes(value);
}

export function isModelGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === "string" && (MODEL_GOAL_STATUSES as readonly string[]).includes(value);
}

export function validateObjective(objective: unknown): string {
  if (typeof objective !== "string") throw new Error("goal objective must be a string");
  const trimmed = objective.trim();
  if (!trimmed) throw new Error("goal objective must not be empty");
  if (trimmed.length > GOAL_OBJECTIVE_MAX_CHARS) {
    throw new Error(`goal objective must be at most ${GOAL_OBJECTIVE_MAX_CHARS} characters`);
  }
  return trimmed;
}

export function validateTokenBudget(value: unknown, max?: number): number | undefined {
  if (value === undefined || value === null) return max;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("goal token_budget must be a positive safe integer when provided");
  }
  if (max !== undefined && value > max) {
    throw new Error(`goal token budget ${value} exceeds the maximum allowed goal token budget of ${max}`);
  }
  return value;
}

export function goalSnapshot(goal: GoalState): GoalSnapshot {
  return {
    ...goal,
    remainingTokens: goal.tokenBudget === undefined
      ? undefined
      : Math.max(0, goal.tokenBudget - goal.tokensUsed),
  };
}

export function isUnfinished(goal: GoalState | undefined): boolean {
  return Boolean(goal && goal.status !== "complete" && goal.status !== "usage_limited" && goal.status !== "budget_limited");
}

/** Terminal statuses cannot be resumed by the model; user actions can replace them. */
export function isTerminalStatus(status: GoalStatus): boolean {
  return status === "complete" || status === "usage_limited" || status === "budget_limited";
}
