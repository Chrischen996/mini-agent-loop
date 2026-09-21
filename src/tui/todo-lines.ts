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
  const skippedCount = items.filter((item) => item.status === "skipped").length;
  const status = plan ? ` [${TODO_PLAN_STATUS_LABELS[plan.status]}]` : "";
  const meter = todoProgressMeter(summary.completed, summary.total);
  const header = [
    `Todos  ${meter}  ${summary.completed}/${summary.total} completed`,
    summary.inProgress ? `  ${summary.inProgress} in progress` : "",
    summary.failed ? `  ${summary.failed} failed` : "",
    skippedCount ? `  ${skippedCount} skipped` : "",
    status ? `  ${status}` : "",
  ].join("");

  if (viewMode === "compact") {
    const active = items.find((item) => item.status === "in_progress");
    const activeLabel = active?.activeForm ?? (summary.total > 0 && summary.completed === summary.total ? "All tasks completed" : "No active task");
    return [{
      key: "todo-compact",
      text: `${header}  ▸  ·  ${todoText(activeLabel, 72)}`,
      prefix: "☷ ",
      style: "todo",
      dim: !active,
    }];
  }

  // expanded mode — group items: in_progress → pending → done/failed/skipped
  const inProgressItems = items.filter((item) => item.status === "in_progress");
  const pendingItems = items.filter((item) => item.status === "pending");
  const doneItems = items.filter(
    (item) => item.status === "completed" || item.status === "failed" || item.status === "skipped",
  );

  const ordered: TodoItem[] = [...inProgressItems, ...pendingItems, ...doneItems];
  const visible = ordered.slice(0, maxVisibleItems);

  const visibleInProgress = visible.filter((item) => item.status === "in_progress");
  const visiblePending = visible.filter((item) => item.status === "pending");
  const visibleDone = visible.filter(
    (item) => item.status === "completed" || item.status === "failed" || item.status === "skipped",
  );

  const lines: RenderLine[] = [{ key: "todo-header", text: `${header}  ▾`, prefix: "☷ ", style: "todo", bold: true }];

  if (!visible.length) {
    lines.push({ key: "todo-empty", text: "No todos", style: "muted", dim: true });
  } else {
    let sepIndex = 0;
    let added = 0;

    const addGroup = (group: TodoItem[]) => {
      if (group.length === 0) return;
      if (added > 0) {
        lines.push({ key: `todo-sep-${sepIndex++}`, text: "─────", style: "muted", dim: true });
      }
      for (const item of group) {
        const originalIndex = items.indexOf(item);
        // For in_progress, prefer activeForm if different from content
        const displayText =
          item.status === "in_progress" && item.activeForm !== item.content
            ? item.activeForm
            : item.content;
        lines.push({
          key: `todo-${item.id}`,
          text: `${todoIcon(item.status)} ${item.source === "plan" ? `${originalIndex + 1}. ` : ""}${todoText(displayText)}`,
          style: "todo",
          tone: todoTone(item.status),
          strikethrough: item.status === "completed",
          dim: item.status === "skipped",
        });
        added++;
      }
    };

    addGroup(visibleInProgress);
    addGroup(visiblePending);
    addGroup(visibleDone);
  }

  if (items.length > visible.length) lines.push({ key: "todo-more", text: `… ${items.length - visible.length} more`, style: "muted", dim: true });
  return lines;
}

function todoTone(status: TodoStatus): "default" | "success" | "running" | "error" {
  if (status === "completed") return "success";
  if (status === "in_progress") return "running";
  if (status === "failed") return "error";
  return "default";
}
