import type { WebRunBudgetUsage, WebRunPolicy } from "../types/api.ts";

/** Both stream events and restored checkpoints use the same pause explanation. */
export function runStopText(state: {
  reason?: unknown;
  details?: unknown;
  message?: unknown;
  maxSteps?: unknown;
  budgetUsage?: unknown;
  cumulativeBudgetUsage?: unknown;
  budgetPolicy?: unknown;
}): string {
  const reasons: Record<string, string> = {
    stalled: "Repeated actions or no progress were detected; the run was paused to protect the budget.",
    budget_exhausted: "The run budget was exhausted; progress was saved.",
    safety_cap_reached: "The emergency iteration cap was reached; check for an unexpected loop before continuing.",
    context_exhausted: "The context compaction limit was reached; progress was saved.",
    step_limit: `Execution limit reached (${String(state.maxSteps ?? "unknown")} steps); progress saved.`,
    server_restart: "The previous run was interrupted by a server restart; progress was saved.",
  };
  const text = typeof state.details === "string" && state.details
    ? state.details : typeof state.message === "string" && state.message
      ? state.message : reasons[String(state.reason)] ?? "Execution paused; progress saved.";
  const current = formatUsage(state.budgetUsage, state.budgetPolicy);
  const total = formatUsage(state.cumulativeBudgetUsage);
  return [text, current && `This budget: ${current}.`, total && `Session total: ${total}.`, "Continue allocates a new budget."].filter(Boolean).join("\n");
}

function formatUsage(value: unknown, limits?: unknown): string {
  if (!value || typeof value !== "object") return "";
  const usage = value as WebRunBudgetUsage;
  const policy = (limits && typeof limits === "object" ? limits : {}) as WebRunPolicy;
  const amount = (used: number | undefined, limit: number | undefined, label: string, scale = 1): string => {
    if (typeof used !== "number" || !Number.isFinite(used)) return "";
    const number = (value: number) => scale === 1 ? String(value) : (value / scale).toFixed(1);
    return `${number(used)}${typeof limit === "number" && Number.isFinite(limit) ? `/${number(limit)}` : ""} ${label}`;
  };
  return [
    amount(usage.tokensUsed, policy.tokenBudget, "tokens"),
    amount(usage.toolCallsUsed, policy.toolCallBudget, "tool calls"),
    amount(usage.writeCallsUsed, policy.writeCallBudget, "writes"),
    amount(usage.elapsedMs, policy.deadlineMs, "seconds" , 1000),
  ].filter(Boolean).join(", ");
}
