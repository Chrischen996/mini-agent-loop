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
import type { RenderLine } from "./render-lines.ts";
import { formatRenderLine } from "./render-line-format.ts";

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
  moveTo: (row: number, col: number) => `\x1b[${row};${col}H`,
};

function short(value: string, max = 160): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
}

function appendMemoryCards(lines: RenderLine[], events: MemoryUpdateEvent[] | undefined): void {
  if (!events || events.length === 0) return;
  for (const [eventIndex, event] of events.slice(-3).entries()) {
    const time = new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false });
    lines.push({ key: `memory-${eventIndex}-top`, text: `Memory updated ${time}`, prefix: "┌─ ", style: "border", bold: true });
    for (const key of event.added) {
      const preview = event.previews?.[key] ? ` — ${short(event.previews[key]!, 60)}` : "";
      lines.push({ key: `memory-${eventIndex}-add-${key}`, text: `${key}${preview}`, prefix: "+ ", style: "muted", tone: "success" });
    }
    for (const key of event.forgotten) {
      lines.push({ key: `memory-${eventIndex}-forget-${key}`, text: `${key} (forgotten)`, prefix: "− ", style: "muted", tone: "error", dim: true });
    }
    if (event.added.length === 0 && event.forgotten.length === 0) {
      lines.push({ key: `memory-${eventIndex}-empty`, text: "(no changes)", prefix: "│  ", style: "muted", dim: true });
    }
    lines.push({ key: `memory-${eventIndex}-bottom`, text: " active next turn · /memory to inspect", prefix: "└─", style: "border", dim: true });
  }
}

function appendTextLines(
  lines: RenderLine[],
  key: string,
  text: string,
  options: Pick<RenderLine, "prefix" | "prefixTone" | "style" | "tone" | "bold" | "dim" | "background" | "fillWidth">,
): void {
  const source = text.replace(/\r\n?/g, "\n").split("\n");
  source.forEach((value, index) => lines.push({
    key: `${key}-${index}`,
    text: value,
    ...options,
    prefix: index === 0 ? options.prefix : " ".repeat(terminalStringWidth(options.prefix ?? "")),
  }));
}

/** Build the legacy frame from the same row model consumed by the ANSI path. */
export function buildLegacyRenderLines(state: LegacyTuiState, width = 80): RenderLine[] {
  const lines: RenderLine[] = [
    { key: "legacy-header", text: "Claude Code", prefix: "✻ ", style: "assistant", bold: true },
    { key: "legacy-header-gap", text: "", style: "muted" },
  ];

  for (const [messageIndex, message] of state.history.filter((item) => item.role !== "system").entries()) {
    const content = contentAsString(message.content);
    if (message.role === "user") {
      // A child-agent prompt can be persisted in the parent history by
      // gateways that flatten nested turns. Keep its protocol scaffold out of
      // the user-facing transcript; the parent subagent progress row is the
      // canonical representation.
      if (/^\s*you are .*subagent\b/i.test(content)) continue;
      appendTextLines(lines, `history-${messageIndex}`, content, {
        prefix: "❯ ", style: "user", background: "user", fillWidth: width,
      });
    }
    if (message.role === "assistant" && message.content
      && !isSubagentProtocolText(message.content)
      && !/^\s*you are .*subagent\b/i.test(message.content)) {
      appendTextLines(lines, `history-${messageIndex}`, message.content, { prefix: "⏺ ", style: "assistant" });
    }
    if (message.role === "tool" && !isSubagentToolName(message.name)) {
      lines.push({ key: `history-${messageIndex}-tool`, text: toolVisualName(message.name), prefix: "⏺ ", style: "tool", bold: true, prefixTone: message.isError ? "error" : "success", tone: message.isError ? "error" : undefined });
      appendTextLines(lines, `history-${messageIndex}-result`, short(content), { prefix: "  ⎿ ", style: "muted", dim: true, tone: message.isError ? "error" : undefined });
    }
  }

  if (state.todoPlan || state.todoItems) {
    lines.push(...todoPanelRenderLines({ plan: state.todoPlan, todos: state.todoItems, viewMode: state.todoViewMode ?? "expanded", maxVisibleItems: TODO_PANEL_MAX_VISIBLE_ITEMS }));
    lines.push({ key: "legacy-todo-gap", text: "", style: "muted" });
  }

  appendMemoryCards(lines, state.memoryEvents);

  if (state.notice) {
    const title = noticeTitle(state.notice.title);
    if (title) lines.push({ key: "legacy-notice-title", text: title, prefix: "── ", style: "border", bold: true });
    const noticeLines = noticeText(state.notice.text).split("\n");
    noticeLines.slice(0, 8).forEach((line, index) => lines.push({ key: `legacy-notice-${index}`, text: line, prefix: "  ", style: "muted", dim: true }));
    if (noticeLines.length > 8) lines.push({ key: "legacy-notice-more", text: "...", prefix: "  ", style: "muted", dim: true });
  }

  if (state.pendingUser) {
    appendTextLines(lines, "legacy-pending-user", state.pendingUser, { prefix: "❯ ", style: "user", background: "user", fillWidth: width });
  }
  if (state.streamingText) appendTextLines(lines, "legacy-streaming", state.streamingText, { prefix: "⏺ ", style: "assistant", prefixTone: "running" });

  // A completed turn is present in both the persisted Agent history and the
  // transient tool list until the next submission resets that list. Keep the
  // history row as the canonical transcript and only draw tools that have not
  // been committed yet, so a tool result cannot appear twice after completion.
  const committedToolIds = new Set(
    state.history
      .filter((message): message is Extract<AgentMessage, { role: "tool" }> => message.role === "tool")
      .map((message) => message.toolCallId),
  );
  for (const tool of state.tools.slice(-4)) {
    if (isSubagentToolName(tool.name)) continue;
    if (committedToolIds.has(tool.id)) continue;
    const tone = tool.status === "error" ? "error" : tool.status === "running" ? "running" : "success";
    lines.push({ key: `legacy-tool-${tool.id}`, text: toolVisualName(tool.name), prefix: "⏺ ", style: "tool", bold: true, prefixTone: tone, tone: tool.status === "error" ? "error" : undefined });
    if (tool.preview) appendTextLines(lines, `legacy-tool-${tool.id}-result`, short(tool.preview, 100), { prefix: "  ⎿ ", style: "muted", dim: true, tone: tool.status === "error" ? "error" : undefined });
  }

  lines.push(
    { key: "legacy-footer-gap", text: "", style: "muted" },
    { key: "legacy-status", text: `${thinkingLevelLabel(thinkingLevelToDisplay(state.thinkingLevel))} · ${permissionModeLabel(state.permissionMode)} · ${statusLabel(state.status, state.busy)}`, prefix: state.busy ? "⟳ " : "· ", style: "muted", dim: true, prefixTone: state.busy ? "running" : "success" },
    { key: "legacy-input", text: state.input, prefix: state.busy ? "" : "❯ ", style: "assistant", bold: !state.busy },
  );
  return lines;
}

/** Compatibility string API retained for the original legacy renderer. */
export function buildLegacyFrameLines(state: LegacyTuiState, width = 80): string[] {
  return buildLegacyRenderLines(state, width).map(formatRenderLine);
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
