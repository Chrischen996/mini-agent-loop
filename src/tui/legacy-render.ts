import { contentAsString } from "../content.ts";
import { thinkingLevelToDisplay } from "../think-intensity.ts";
import type { ModelThinkingLevel } from "../pi-ai/types.ts";
import type { AgentMessage } from "../types.ts";
import type { PermissionMode } from "../permissions.ts";
import type { PlanDocument } from "../plan/document.ts";
import type { TodoItem, TodoViewMode } from "../todo.ts";
import { TODO_PANEL_MAX_VISIBLE_ITEMS } from "./todo-format.ts";
import { countTerminalRows, terminalStringWidth } from "./terminal-width.ts";
import { todoPanelRenderLines } from "./todo-lines.ts";
import { noticeText, noticeTitle, permissionModeLabel, statusLabel, thinkingLevelLabel } from "./claude-style.ts";
import { isSubagentProtocolText, isSubagentToolName } from "./subagent-lines.ts";
import { toolVisualName } from "./tool-lines.ts";

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

/** One auto-memory extraction outcome, rendered as an inline card. */
export type MemoryUpdateEvent = {
  /** Memory keys created or updated. */
  added: string[];
  /** Memory keys marked forgotten. */
  forgotten: string[];
  /** Wall-clock time of the update. */
  at: number;
  /** Optional key→content previews for richer display. */
  previews?: Record<string, string>;
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
  /** Auto-memory updates from completed turns, rendered as inline cards. */
  memoryEvents?: MemoryUpdateEvent[];
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
  const renderLines = todoPanelRenderLines({ plan, todos, viewMode, maxVisibleItems: TODO_PANEL_MAX_VISIBLE_ITEMS });
  for (const line of renderLines) {
    const color = line.tone === "success" ? ANSI.green : line.tone === "running" ? ANSI.yellow : line.tone === "error" ? ANSI.red : line.style === "muted" ? ANSI.dim : ANSI.cyan;
    const attributes = `${line.strikethrough ? ANSI.strike : ""}${line.dim ? ANSI.dim : ""}`;
    lines.push(`${color}${attributes}${line.prefix ?? ""}${line.text}${ANSI.reset}`);
  }
}

function appendMemoryCards(lines: string[], events: MemoryUpdateEvent[] | undefined): void {
  if (!events || events.length === 0) return;
  for (const event of events.slice(-3)) {
    const time = new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false });
    lines.push(`${ANSI.cyan}┌─ Memory updated ${ANSI.dim}${time}${ANSI.reset}`);
    const rows: string[] = [];
    for (const key of event.added) {
      const preview = event.previews?.[key] ? ` ${ANSI.dim}— ${short(event.previews[key]!, 60)}${ANSI.reset}` : "";
      rows.push(`${ANSI.green}+${ANSI.reset} ${key}${preview}`);
    }
    for (const key of event.forgotten) {
      rows.push(`${ANSI.red}−${ANSI.reset} ${key} ${ANSI.dim}(forgotten)${ANSI.reset}`);
    }
    if (rows.length === 0) rows.push(`${ANSI.dim}(no changes)${ANSI.reset}`);
    lines.push(...rows);
    lines.push(`${ANSI.cyan}└${ANSI.reset}${ANSI.dim} active next turn · /memory to inspect${ANSI.reset}`);
  }
}

export function buildLegacyFrameLines(state: LegacyTuiState): string[] {
  const lines: string[] = [
    `${ANSI.cyan}Claude Code${ANSI.reset}`,
    "",
  ];

  for (const message of state.history.filter((item) => item.role !== "system")) {
    const content = contentAsString(message.content);
    if (message.role === "user") {
      // A child-agent prompt can be persisted in the parent history by
      // gateways that flatten nested turns. Keep its protocol scaffold out of
      // the user-facing transcript; the parent subagent progress row is the
      // canonical representation.
      if (/^\s*you are .*subagent\b/i.test(content)) continue;
      lines.push(`${ANSI.green}❯ ${ANSI.reset}${content}`);
    }
    if (message.role === "assistant" && message.content
      && !isSubagentProtocolText(message.content)
      && !/^\s*you are .*subagent\b/i.test(message.content)) {
      lines.push(`${ANSI.cyan}⏺ ${ANSI.reset}${message.content}`);
    }
    if (message.role === "tool" && !isSubagentToolName(message.name)) {
      lines.push(`${ANSI.cyan}⏺ ${toolVisualName(message.name)}${ANSI.reset}`);
      lines.push(`${ANSI.dim}  ⎿ ${short(content)}${ANSI.reset}`);
    }
  }

  if (state.todoPlan || state.todoItems) {
    appendTodoLines(lines, state.todoPlan, state.todoItems, state.todoViewMode ?? "expanded");
    lines.push("");
  }

  appendMemoryCards(lines, state.memoryEvents);

  if (state.notice) {
    const title = noticeTitle(state.notice.title);
    if (title) lines.push(`${ANSI.cyan}${title}:${ANSI.reset}`);
    const noticeLines = noticeText(state.notice.text).split("\n");
    lines.push(...noticeLines.slice(0, 8).map((line) => `${ANSI.dim}${line}${ANSI.reset}`));
    if (noticeLines.length > 8) lines.push(`${ANSI.dim}...${ANSI.reset}`);
  }

  if (state.pendingUser) {
    const normalized = state.pendingUser.replace(/\r\n/g, '\n');
    lines.push(`${ANSI.green}❯ ${ANSI.reset}${normalized}`);
  }
  if (state.streamingText) lines.push(`${ANSI.cyan}⏺ ${ANSI.reset}${state.streamingText}`);

  for (const tool of state.tools.slice(-4)) {
    if (isSubagentToolName(tool.name)) continue;
    const icon = tool.status === "running" ? `${ANSI.yellow}⟳` : tool.status === "error" ? `${ANSI.red}✗` : `${ANSI.green}✓`;
    lines.push(`${ANSI.dim}⎿ ${icon}${ANSI.reset} ${tool.name}${tool.preview ? ` ${ANSI.dim}${short(tool.preview, 100)}${ANSI.reset}` : ""}`);
  }

  lines.push(
    "",
    `${ANSI.dim}Thinking: ${thinkingLevelLabel(thinkingLevelToDisplay(state.thinkingLevel))} · ${permissionModeLabel(state.permissionMode)} · ${statusLabel(state.status, state.busy)}${ANSI.reset}`,
    `${state.busy ? "" : "❯ "}${state.input}`,
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
