import type { PlanDocument } from "../plan/document.ts";
import type { TodoItem, TodoStatus, TodoViewMode } from "../todo.ts";
import { todoSummary } from "../todo.ts";
import { resolveTodoItems, todoIcon, todoProgressMeter, todoText, TODO_PANEL_MAX_VISIBLE_ITEMS, TODO_PLAN_STATUS_LABELS } from "./todo-format.ts";
import type { RenderLine } from "./render-lines.ts";

export function todoPanelRenderLines(options: { plan?: PlanDocument; todos?: readonly TodoItem[]; viewMode?: TodoViewMode; maxVisibleItems?: number }): RenderLine[] {
  const { plan, todos, viewMode = "expanded", maxVisibleItems = TODO_PANEL_MAX_VISIBLE_ITEMS } = options;
  if (viewMode === "hidden" || (!plan && !todos)) return [];
  const items = resolveTodoItems({ plan, todos });
  const summary = todoSummary(items);
  const status = plan ? ` [${TODO_PLAN_STATUS_LABELS[plan.status]}]` : "";
  const meter = todoProgressMeter(summary.completed, summary.total);
  const header = `Todos  ${meter}  ${summary.completed}/${summary.total} completed${summary.inProgress ? `  ${summary.inProgress} in progress` : ""}${summary.failed ? `  ${summary.failed} failed` : ""}${status ? `  ${status}` : ""}`;
  if (viewMode === "compact") {
    const active = items.find((item) => item.status === "in_progress");
    const activeLabel = active?.activeForm ?? (summary.total > 0 && summary.completed === summary.total ? "All tasks completed" : "No active task");
    return [{
      key: "todo-compact",
      text: `${header}  ·  ${todoText(activeLabel, 72)}`,
      prefix: "☷ ",
      style: "todo",
      dim: !active,
    }];
  }
  const lines: RenderLine[] = [{ key: "todo-header", text: header, prefix: "☷ ", style: "todo", bold: true }];
  const visible = items.slice(0, maxVisibleItems);
  if (!visible.length) lines.push({ key: "todo-empty", text: "No todos", style: "muted", dim: true });
  for (const [index, item] of visible.entries()) lines.push({ key: `todo-${item.id}`, text: `${todoIcon(item.status)} ${item.source === "plan" ? `${index + 1}. ` : ""}${todoText(item.content)}`, style: "todo", tone: todoTone(item.status), strikethrough: item.status === "completed", dim: item.status === "skipped" });
  if (items.length > visible.length) lines.push({ key: "todo-more", text: `… ${items.length - visible.length} more`, style: "muted", dim: true });
  return lines;
}

function todoTone(status: TodoStatus): "default" | "success" | "running" | "error" {
  if (status === "completed") return "success";
  if (status === "in_progress") return "running";
  if (status === "failed") return "error";
  return "default";
}
