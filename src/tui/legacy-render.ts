import { contentAsString } from "../content.ts";
import { thinkingLevelToDisplay } from "../think-intensity.ts";
import type { ModelThinkingLevel } from "../pi-ai/types.ts";
import type { AgentMessage } from "../types.ts";
import type { PermissionMode } from "../permissions.ts";
import type { PlanDocument } from "../plan/document.ts";
import { todoSummary, type TodoItem, type TodoViewMode } from "../todo.ts";
import {
  resolveTodoItems,
  todoColor,
  todoIcon,
  todoText,
  TODO_PANEL_MAX_VISIBLE_ITEMS,
  TODO_PLAN_STATUS_LABELS,
} from "./todo-format.ts";
import { countTerminalRows, terminalStringWidth } from "./terminal-width.ts";

export type LegacyToolView = {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  preview?: string;
};

export type LegacyNotice = {
  title?: string;
  text: string;
};

export type LegacyTuiState = {
  history: AgentMessage[];
  streamingText: string;
  tools: LegacyToolView[];
  busy: boolean;
  input: string;
  pendingUser?: string;
  status: string;
  permissionMode: PermissionMode;
  thinkingLevel: ModelThinkingLevel;
  todoPlan?: PlanDocument;
  todoItems?: TodoItem[];
  todoRevision?: number;
  todoViewMode?: TodoViewMode;
  notice?: LegacyNotice;
};

const ANSI = {
  cursorHome: "\x1b[H",
  eraseLine: "\x1b[2K",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  strike: "\x1b[9m",
  moveTo: (row: number, col: number) => `\x1b[${row};${col}H`,
};

function short(value: string, max = 160): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
}

function appendTodoLines(
  lines: string[],
  plan: PlanDocument | undefined,
  todos: readonly TodoItem[] | undefined,
  viewMode: TodoViewMode,
): void {
  if (viewMode === "hidden") return;
  const items = resolveTodoItems({ plan, todos });
  const summary = todoSummary(items);
  const planStatus = plan ? ` [${TODO_PLAN_STATUS_LABELS[plan.status]}]` : "";
  lines.push(
    `${ANSI.cyan}TODO${ANSI.reset}${planStatus} ${summary.completed}/${summary.total}` +
      (summary.inProgress > 0 ? ` ${ANSI.yellow}${summary.inProgress} 执行中${ANSI.reset}` : "") +
      (summary.failed > 0 ? ` ${ANSI.red}${summary.failed} 失败${ANSI.reset}` : ""),
  );
  if (viewMode === "compact") {
    const current = items.find((item) => item.status === "in_progress");
    lines.push(`${ANSI.dim}${current?.activeForm ?? "任务列表已折叠"}${ANSI.reset}`);
    return;
  }
  if (items.length === 0) {
    lines.push(`${ANSI.dim}暂无结构化步骤${ANSI.reset}`);
    return;
  }
  const visibleItems = items.slice(0, TODO_PANEL_MAX_VISIBLE_ITEMS);
  for (const [index, item] of visibleItems.entries()) {
    const color = {
      green: ANSI.green,
      red: ANSI.red,
      yellow: ANSI.yellow,
      gray: ANSI.dim,
    }[todoColor(item.status)];
    const strike = item.status === "completed" ? ANSI.strike : "";
    const number = item.source === "plan" ? `${index + 1}. ` : "";
    lines.push(`${color}${strike}${todoIcon(item.status)}${ANSI.reset} ${strike}${number}${todoText(item.content)}${ANSI.reset}`);
  }
  if (items.length > visibleItems.length) {
    lines.push(`${ANSI.dim}... 还有 ${items.length - visibleItems.length} 项${ANSI.reset}`);
  }
}

export function buildLegacyFrameLines(state: LegacyTuiState): string[] {
  const lines: string[] = [
    `${ANSI.cyan}mini-agent TUI${ANSI.reset} ${ANSI.dim}(Ctrl+R 快切思考，Shift+↑↓ 精调，Shift+Tab 切换权限，输入 /clear 清空会话)${ANSI.reset}`,
    "",
  ];

  for (const message of state.history.filter((item) => item.role !== "system")) {
    if (message.role === "user") lines.push(`${ANSI.green}> ${ANSI.reset}${contentAsString(message.content)}`);
    if (message.role === "assistant" && message.content) lines.push(`${ANSI.cyan}assistant:${ANSI.reset} ${message.content}`);
    if (message.role === "tool") lines.push(`${ANSI.dim}[${message.name}] ${short(contentAsString(message.content))}${ANSI.reset}`);
  }

  if (state.todoPlan || state.todoItems) {
    appendTodoLines(lines, state.todoPlan, state.todoItems, state.todoViewMode ?? "expanded");
    lines.push("");
  }

  if (state.notice) {
    if (state.notice.title) lines.push(`${ANSI.cyan}${state.notice.title}:${ANSI.reset}`);
    const noticeLines = state.notice.text.split("\n");
    lines.push(...noticeLines.slice(0, 8).map((line) => `${ANSI.dim}${line}${ANSI.reset}`));
    if (noticeLines.length > 8) lines.push(`${ANSI.dim}...${ANSI.reset}`);
  }

  if (state.pendingUser) {
    const normalized = state.pendingUser.replace(/\r\n/g, '\n');
    const lineCount = normalized.split('\n').length;
    const isMultiLine = lineCount > 1;
    const charCount = [...normalized].length;
    const display = isMultiLine ? `${lineCount} 行 / ${charCount} 字` : normalized;
    lines.push(`${ANSI.green}> ${ANSI.reset}${display}`);
  }
  if (state.streamingText) lines.push(`${ANSI.cyan}assistant:${ANSI.reset} ${state.streamingText}`);

  for (const tool of state.tools.slice(-4)) {
    const icon = tool.status === "running" ? `${ANSI.yellow}*` : tool.status === "error" ? `${ANSI.red}!` : `${ANSI.green}ok`;
    lines.push(`${icon}${ANSI.reset} ${tool.name}${tool.preview ? ` ${ANSI.dim}${short(tool.preview, 100)}${ANSI.reset}` : ""}`);
  }

  lines.push(
    "",
    `${ANSI.dim}思考: ${thinkingLevelToDisplay(state.thinkingLevel)} · 权限: ${state.permissionMode} · ${state.status}${ANSI.reset}`,
    `${state.busy ? "" : "> "}${state.input}`,
  );
  return lines;
}

/**
 * Cover the current frame in place and erase rows left over from the previous
 * frame. It intentionally avoids ESC[2J, which causes visible full-screen
 * flashes in terminals while reasoning deltas arrive.
 */
export function buildLegacyFrameRowCount(lines: string[], columns = 80): number {
  return lines.reduce((rows, line) => rows + Math.max(1, countTerminalRows(line, columns)), 0);
}

export function buildLegacyFrameOutput(lines: string[], previousRowCount = 0, columns = 80): string {
  const clearPrevious = Array.from({ length: previousRowCount }, (_, index) =>
    `${ANSI.moveTo(index + 1, 1)}${ANSI.eraseLine}`,
  ).join("");
  const output = [ANSI.cursorHome, ...lines.map((line) => `${ANSI.eraseLine}${line.replaceAll("\n", `\n${ANSI.eraseLine}`)}`)].join("\n");
  return `${ANSI.cursorHome}${clearPrevious}${output}`;
}

export function buildLegacyCursorOutput(lines: string[], state: Pick<LegacyTuiState, "busy" | "input">, columns = 80): string {
  if (state.busy) return ANSI.hideCursor;
  const inputRow = buildLegacyFrameRowCount(lines, columns);
  const prefixWidth = state.busy ? 0 : 2;
  const usedColumns = prefixWidth + terminalStringWidth(state.input);
  const remainder = usedColumns % Math.max(1, columns);
  const inputCol = usedColumns > 0 && remainder === 0 ? columns : remainder + 1;
  return `${ANSI.moveTo(inputRow, inputCol)}${ANSI.showCursor}`;
}

export const LEGACY_ANSI = {
  alternateScreen: "\x1b[?1049h",
  mainScreen: "\x1b[?1049l",
};
