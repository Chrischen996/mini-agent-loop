import type { TodoItem, TodoStatus } from "../todo.ts";
import { nextTodoRevision } from "../todo.ts";
import type { RunnerOutcome } from "./runner.ts";
import type { RunnerPlan } from "./types.ts";

/**
 * Merge runner outcomes back into the session's TodoItem list.
 *
 * - completed task  → item status "completed"
 * - failed task     → item status "failed" (+ error)
 * - blocked task    → item status "skipped" with the blocking reason
 * - running/pending → item status "in_progress" / "pending"
 *
 * Every write-back bumps the todo revision so `SET_TODO_ITEMS` in the TUI
 * reducer accepts the update (`isTodoRevisionNewer`).
 */
export function mergeOutcomesIntoTodos(
  todos: readonly TodoItem[],
  outcomes: readonly RunnerOutcome[],
): { todos: TodoItem[]; revision: number } {
  const byTaskId = new Map(outcomes.map((outcome) => [outcome.taskId, outcome]));
  const mapped: TodoItem[] = todos.map((item) => {
    const outcome = byTaskId.get(item.id);
    if (!outcome) return { ...item };
    const status: TodoStatus = outcome.ok ? "completed" : "failed";
    const next: TodoItem = {
      ...item,
      status,
      ...(outcome.error ? { error: outcome.error } : { error: undefined }),
    };
    return next;
  });
  return { todos: mapped, revision: nextTodoRevision() };
}

/**
 * Format a per-task outcome row for the TUI notice, e.g.
 * `✓ auth-api — added token endpoint (2m 14s)` or
 * `✗ e2e — dependency "auth-api" failed`.
 */
export function formatOutcome(outcome: RunnerOutcome, taskLabel?: string, content?: string): string {
  const label = taskLabel ?? outcome.taskId;
  const detail = outcome.ok ? outcome.summary : outcome.error;
  const mark = outcome.ok ? "✓" : "✗";
  const subject = content ? `${label} — ${content}` : label;
  return detail ? `${mark} ${subject}: ${detail}` : `${mark} ${subject}`;
}

/**
 * Summary line over a whole plan run: `3 done · 1 failed · 1 blocked`.
 */
export function summarizeOutcomes(plan: RunnerPlan, outcomes: readonly RunnerOutcome[]): string {
  const done = outcomes.filter((outcome) => outcome.ok).length;
  const failed = outcomes.filter((outcome) => !outcome.ok && outcome.error !== undefined).length;
  const blocked = plan.tasks.filter((task) => task.status === "blocked").length;
  return `${done} done · ${failed} failed · ${blocked} blocked`;
}
