import type { PlanDocument } from "../plan/document.ts";
import type { TodoItem, TodoStatus, TodoViewMode } from "../todo.ts";
import { todoSummary } from "../todo.ts";
import { resolveTodoItems, todoIcon, todoText, TODO_PANEL_MAX_VISIBLE_ITEMS, TODO_PLAN_STATUS_LABELS } from "./todo-format.ts";
import type { RenderLine } from "./render-lines.ts";

export function todoPanelRenderLines(options: { plan?: PlanDocument; todos?: readonly TodoItem[]; viewMode?: TodoViewMode; maxVisibleItems?: number }): RenderLine[] {
  const { plan, todos, viewMode = "expanded", maxVisibleItems = TODO_PANEL_MAX_VISIBLE_ITEMS } = options;
  if (viewMode === "hidden" || (!plan && !todos)) return [];
  const items = resolveTodoItems({ plan, todos });
  const summary = todoSummary(items);
  const status = plan ? ` [${TODO_PLAN_STATUS_LABELS[plan.status]}]` : "";
  const header = `TODO  ${summary.completed}/${summary.total} 已完成${summary.inProgress ? `  ${summary.inProgress} 执行中` : ""}${summary.failed ? `  ${summary.failed} 失败` : ""}${status}`;
  const lines: RenderLine[] = [{ key: "todo-header", text: header, style: "todo", bold: true }];
  if (viewMode === "compact") {
    lines.push({ key: "todo-compact", text: items.find((item) => item.status === "in_progress")?.activeForm ?? (items.length ? "任务列表已折叠" : "暂无结构化任务"), style: "muted", dim: true });
    return lines;
  }
  const visible = items.slice(0, maxVisibleItems);
  if (!visible.length) lines.push({ key: "todo-empty", text: "暂无结构化任务", style: "muted", dim: true });
  for (const [index, item] of visible.entries()) lines.push({ key: `todo-${item.id}`, text: `${todoIcon(item.status)} ${item.source === "plan" ? `${index + 1}. ` : ""}${todoText(item.content)}`, style: "todo", tone: todoTone(item.status), strikethrough: item.status === "completed", dim: item.status === "skipped" });
  if (items.length > visible.length) lines.push({ key: "todo-more", text: `... 还有 ${items.length - visible.length} 项`, style: "muted", dim: true });
  return lines;
}

function todoTone(status: TodoStatus): "default" | "success" | "running" | "error" {
  if (status === "completed") return "success";
  if (status === "in_progress") return "running";
  if (status === "failed") return "error";
  return "default";
}
