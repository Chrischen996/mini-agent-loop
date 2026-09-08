import type { TodoItem, TodoStatus, TodoViewMode } from "../todo.ts";
import { formatTokenCount } from "./status-line.ts";
import { terminalStringWidth } from "./terminal-width.ts";
import { todoText } from "./todo-format.ts";
import type { RenderLine } from "./render-lines.ts";

export type TaskSummaryStatus = "running" | "completed" | "failed" | "cancelled";

export type TaskSummaryInput = {
  title: string;
  status: TaskSummaryStatus;
  durationMs?: number;
  totalTokens?: number;
  todos: readonly TodoItem[];
  viewMode?: TodoViewMode;
  maxVisibleItems?: number;
  width?: number;
};

const DEFAULT_MAX_VISIBLE_ITEMS = 8;

/** Project a task and its checklist into the shared TUI row model. */
export function taskSummaryRenderLines(input: TaskSummaryInput): RenderLine[] {
  if (input.viewMode === "hidden" || !input.title.trim() || input.todos.length === 0) return [];

  const maxVisibleItems = Math.max(1, input.maxVisibleItems ?? DEFAULT_MAX_VISIBLE_ITEMS);
  const stats = [
    formatDuration(input.durationMs),
    input.totalTokens && input.totalTokens > 0 ? `↓ ${formatTokenCount(input.totalTokens)} tokens` : "",
  ].filter(Boolean);
  const rootTone = input.status === "failed" || input.status === "cancelled"
    ? "error"
    : input.status === "completed" ? "success" : "running";
  const rootPrefix = "✻ ";
  const rootText = fitTaskRoot(input.title, stats, input.width, rootPrefix);
  const lines: RenderLine[] = [{
    key: "task-summary-root",
    text: rootText,
    prefix: rootPrefix,
    prefixTone: rootTone,
    style: "tool",
    bold: true,
  }];

  const visible = input.todos.slice(0, maxVisibleItems);
  visible.forEach((todo, index) => {
    const last = index === visible.length - 1 && input.todos.length <= visible.length;
    lines.push({
      key: `task-summary-item-${todo.id}`,
      text: todoText(todo.content),
      prefix: `  ${last ? "└─" : "├─"} ${todoStatusIcon(todo.status)} `,
      prefixTone: todoStatusTone(todo.status),
      style: todo.status === "failed" ? "error" : "muted",
      tone: todo.status === "failed" ? "error" : undefined,
      dim: todo.status === "completed" || todo.status === "skipped",
      bold: todo.status !== "completed" && todo.status !== "skipped",
      strikethrough: todo.status === "completed",
    });
  });
  if (input.todos.length > visible.length) {
    lines.push({
      key: "task-summary-more",
      text: `… ${input.todos.length - visible.length} more`,
      prefix: "     ",
      style: "muted",
      dim: true,
    });
  }
  return lines;
}

export function taskSummaryRows(input: TaskSummaryInput): number {
  return taskSummaryRenderLines(input).length;
}

/** Finished tasks expand automatically; explicit hide/show commands still win. */
export function taskSummaryViewMode(status: TaskSummaryStatus, viewMode: TodoViewMode): TodoViewMode {
  return status !== "running" && viewMode === "compact" ? "expanded" : viewMode;
}

function todoStatusIcon(status: TodoStatus): string {
  switch (status) {
    case "completed": return "✓";
    case "skipped": return "-";
    default: return "■";
  }
}

function todoStatusTone(status: TodoStatus): "default" | "success" | "running" | "error" {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "in_progress") return "running";
  return "error";
}

function formatDuration(durationMs?: number): string {
  if (durationMs === undefined) return "";
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

function fitTaskRoot(title: string, stats: readonly string[], width: number | undefined, prefix: string): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (width === undefined) return `${normalized}${stats.length > 0 ? ` (${stats.join(" · ")})` : ""}`;

  const budget = Math.max(1, width - terminalStringWidth(prefix));
  const fullStats = stats.length > 0 ? ` (${stats.join(" · ")})` : "";
  const compactStats = stats.length > 1 ? ` (${stats[0]} · ↓${formatTokenCountFromLabel(stats[1]!)})` : fullStats;
  const statVariants = [...new Set([fullStats, compactStats, stats[0] ? ` (${stats[0]})` : "", ""])];
  for (const suffix of statVariants) {
    const titleBudget = budget - terminalStringWidth(suffix);
    if (titleBudget >= 4) return `${fitTaskTitle(normalized, titleBudget)}${suffix}`;
  }
  return fitTaskTitle(`${normalized}${fullStats}`, budget);
}

function formatTokenCountFromLabel(label: string): string {
  return label.replace(/^↓\s*/, "");
}

function fitTaskTitle(title: string, budget: number): string {
  if (terminalStringWidth(title) <= budget) return title;
  let result = "";
  let used = 0;
  for (const character of title) {
    const characterWidth = Math.max(1, terminalStringWidth(character));
    if (used + characterWidth > Math.max(1, budget - 1)) break;
    result += character;
    used += characterWidth;
  }
  return `${result.trimEnd()}…`;
}
