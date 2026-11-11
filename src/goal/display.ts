import type { GoalState, GoalStatus } from "./types.ts";

export const GOAL_USAGE = "Usage: /goal [<objective> | status | clear | pause | resume | complete] [--token-budget N]";

export function formatTokens(value: number): string {
  const safe = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  if (safe >= 1_000_000) {
    const millions = safe / 1_000_000;
    return `${Number(millions.toFixed(millions >= 10 ? 0 : 1))}M`;
  }
  if (safe >= 1_000) {
    const thousands = safe / 1_000;
    return `${Number(thousands.toFixed(thousands >= 100 ? 0 : 1))}K`;
  }
  return String(safe);
}

export function formatElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  if (safe < 60) return `${safe}s`;
  const minutes = Math.floor(safe / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h ${remaining}m`;
  }
  return remaining === 0 ? `${hours}h` : `${hours}h ${remaining}m`;
}

export function goalStatusLabel(status: GoalStatus): string {
  switch (status) {
    case "active": return "active";
    case "paused": return "paused";
    case "blocked": return "stalled";
    case "usage_limited": return "usage limited";
    case "budget_limited": return "limited by budget";
    case "complete": return "complete";
  }
}

/** Compact status-line segment. Active goals prefer budget usage when budgeted. */
export function goalStatusSegment(goal: GoalState): string {
  if (goal.status === "active") {
    return goal.tokenBudget === undefined
      ? `Goal ${formatElapsed(goal.timeUsedSeconds)}`
      : `Goal ${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)}`;
  }
  return `Goal ${goalStatusLabel(goal.status)}`;
}

export function goalUsageSummary(goal: GoalState): string {
  const parts = [`Objective: ${goal.objective}`];
  if (goal.timeUsedSeconds > 0) parts.push(`Time: ${formatElapsed(goal.timeUsedSeconds)}.`);
  if (goal.tokenBudget !== undefined) {
    parts.push(`Tokens: ${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)}.`);
  }
  return parts.join(" ");
}

export function goalNotice(goal: GoalState | undefined): string {
  if (!goal) return "No goal is currently set.";
  return [
    `Goal ${goalStatusLabel(goal.status)}`,
    goalUsageSummary(goal),
    `Status: ${goal.status}`,
  ].join("\n");
}
