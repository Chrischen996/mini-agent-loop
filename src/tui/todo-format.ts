import type { ExecutionPlan, ExecutionStep } from "../plan-act/types.ts";
import type { PlanDocument, PlanStepStatus } from "../plan/document.ts";
import { normalizeTodoText, type TodoItem, type TodoStatus, type TodoViewMode } from "../todo.ts";

export const TODO_PANEL_MAX_VISIBLE_ITEMS = 8;

export const TODO_PLAN_STATUS_LABELS: Record<PlanDocument["status"], string> = {
  pending: "pending",
  approved: "approved",
  rejected: "rejected",
  executing: "in progress",
  completed: "completed",
  failed: "failed",
};

const PLAN_STEP_TODO_STATUS: Record<PlanStepStatus, TodoStatus> = {
  todo: "pending",
  doing: "in_progress",
  done: "completed",
  skipped: "skipped",
  failed: "failed",
};

export function planStepStatusToTodoStatus(status?: PlanStepStatus): TodoStatus {
  return status ? PLAN_STEP_TODO_STATUS[status] : "pending";
}

export function executionStepStatusToTodoStatus(status?: ExecutionStep["status"]): TodoStatus {
  switch (status) {
    case "running": return "in_progress";
    case "completed": return "completed";
    case "failed": return "failed";
    case "skipped": return "skipped";
    default: return "pending";
  }
}

export type TodoSource = {
  plan?: PlanDocument;
  todos?: readonly TodoItem[];
};

export function planToTodoItems(plan?: PlanDocument): TodoItem[] {
  if (!plan) return [];
  return (plan.steps ?? []).map((step) => {
    const content = normalizeTodoText(step.text);
    return {
      id: `${plan.id}-${step.index}`,
      content,
      activeForm: content,
      status: planStepStatusToTodoStatus(step.status),
      source: "plan",
    } satisfies TodoItem;
  });
}

export function executionPlanToTodoItems(plan: ExecutionPlan): TodoItem[] {
  return plan.steps.map((step) => ({
    id: step.id,
    content: step.description,
    activeForm: step.description,
    status: executionStepStatusToTodoStatus(step.status),
    source: "plan",
  } satisfies TodoItem));
}

export function resolveTodoItems(source: TodoSource): TodoItem[] {
  return source.todos ? [...source.todos] : planToTodoItems(source.plan);
}

export function todoIcon(status: TodoStatus): string {
  switch (status) {
    case "completed": return "☒";
    case "in_progress": return "◐";
    case "failed": return "✗";
    case "skipped": return "-";
    default: return "☐";
  }
}

export function todoColor(status: TodoStatus): "gray" | "yellow" | "green" | "red" {
  switch (status) {
    case "completed": return "green";
    case "in_progress": return "yellow";
    case "failed": return "red";
    default: return "gray";
  }
}

export function todoText(value: string, max = 100): string {
  const normalized = normalizeTodoText(value);
  return normalized.length > max ? `${normalized.slice(0, Math.max(1, max - 3))}...` : normalized;
}

export function getTodoPanelRows(
  source: TodoSource,
  viewMode: TodoViewMode = "expanded",
  maxVisibleItems = TODO_PANEL_MAX_VISIBLE_ITEMS,
): number {
  const items = resolveTodoItems(source);
  if (viewMode === "hidden" || (!source.plan && !source.todos)) return 0;
  if (viewMode === "compact") return 2;
  const visible = Math.min(items.length, maxVisibleItems);
  return 1 + Math.max(1, visible) + (items.length > visible ? 1 : 0);
}
