import type { GoalStatus } from "./types.ts";

export type GoalCommand =
  | { kind: "status" }
  | { kind: "clear" }
  | { kind: "set"; objective: string; tokenBudget?: number; background?: boolean }
  | { kind: "status-change"; status: GoalStatus }
  | { kind: "invalid"; message: string };

/**
 * Parse `/goal` (or a bare goal command) into an explicit user intent.
 * The objective is free text; `--token-budget N` and `--bg` are the options.
 * `--bg` runs the goal as a detached background worker in an isolated git
 * worktree with bypass permissions; without it the goal runs in the foreground.
 */
export function parseGoalCommand(input: string): GoalCommand | undefined {
  const trimmed = input.trim();
  const match = /^\/?goal(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return undefined;
  const rest = (match[1] ?? "").trim();
  if (!rest) return { kind: "status" };
  if (/^status$/i.test(rest)) return { kind: "status" };
  if (/^clear$/i.test(rest)) return { kind: "clear" };
  if (/^pause$/i.test(rest)) return { kind: "status-change", status: "paused" };
  if (/^resume$/i.test(rest)) return { kind: "status-change", status: "active" };
  if (/^complete$/i.test(rest)) return { kind: "status-change", status: "complete" };

  const budgetMatch = rest.match(/--token-budget\s+(\d+)/i);
  let objective = rest;
  let tokenBudget: number | undefined;
  if (budgetMatch) {
    tokenBudget = Number(budgetMatch[1]);
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0) {
      return { kind: "invalid", message: "Goal token budget must be a positive integer." };
    }
    objective = rest.replace(budgetMatch[0], "").trim();
  }
  // `--bg` / `--background` anywhere in the objective opts into the detached
  // background runner. Strip the flag so it never reaches the model prompt.
  const bgMatch = objective.match(/(?:^|\s)--(?:bg|background)(?=\s|$)/i);
  const background = bgMatch !== null;
  if (bgMatch) objective = objective.replace(bgMatch[0], " ").trim();
  if (!objective) return { kind: "invalid", message: "Goal objective must not be empty." };
  return {
    kind: "set",
    objective,
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    ...(background ? { background: true } : {}),
  };
}
