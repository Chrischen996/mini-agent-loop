import type { ChatMessage } from "./state.ts";
import { markdownRowText, parseMarkdownLines } from "./markdown-lines.ts";
import { noticeText, noticeTitle, toolArgumentSummary } from "./claude-style.ts";
import { isSubagentProtocolText, isSubagentToolName } from "./subagent-lines.ts";
import { toolVisualName, toolVisualStatusIcon } from "./tool-lines.ts";
import { streamingPreviewTail } from "./text-utils.ts";

const TOOL_PREVIEW_LINES = 15;

/** One already-wrapped transcript row. Ink paints these without measuring markdown. */
export type TranscriptRow = {
  key: string;
  text: string;
};

function rowsFor(text: string, width: number): string[] {
  const budget = Math.max(10, width);
  const source = text.replace(/\r/g, "");
  if (!source) return [];
  const out: string[] = [];
  for (const line of source.split("\n")) {
    if (line.length <= budget) {
      out.push(line);
      continue;
    }
    for (let index = 0; index < line.length; index += budget) out.push(line.slice(index, index + budget));
  }
  return out;
}

function messageRows(message: ChatMessage, width: number, focused: boolean): string[] {
  if (message.kind === "user") {
    return ["", ...rowsFor(`❯ ${message.displayText ?? message.text}`, width)];
  }
  if (message.kind === "assistant") {
    if (isSubagentProtocolText(message.text) || (!message.reasoning && !message.text)) return [];
    const body = message.text
      ? parseMarkdownLines(message.text).map((line) => markdownRowText(line)).join("\n")
      : "";
    const marker = focused ? "◆" : "⏺";
    return ["", ...rowsFor(`${marker} ${body}`, width)];
  }
  if (message.kind === "tool_call") {
    if (isSubagentToolName(message.name)) return [];
    const argument = toolArgumentSummary(message.name, message.rawArgs, message.args).replace(/^\$\s*/, "");
    const head = `${toolVisualStatusIcon(message.status)} ${toolVisualName(message.name)}${argument ? `(${argument})` : ""}`;
    const preview = message.result?.split("\n").slice(0, TOOL_PREVIEW_LINES) ?? [];
    return ["", ...rowsFor([head, ...preview.map((line) => `  ⎿ ${line}`)].join("\n"), width)];
  }
  if (message.kind === "notice") {
    const title = message.title ? `────── ${noticeTitle(message.title)} ──────` : "";
    return ["", ...rowsFor([title, noticeText(message.text)].filter(Boolean).join("\n"), width)];
  }
  if (message.kind === "error") return ["", ...rowsFor(`✗ ${message.text}`, width)];
  if (message.kind === "subagent_call") return ["", ...rowsFor(`⎿ ${message.profile ?? "subagent"} ${message.status}`, width)];
  return [];
}

/**
 * Flatten the visible tail into at most `height` plain rows.
 * Completed messages are cached by object identity, so a spinner tick does not
 * reparse the transcript.
 */
const rowCache = new WeakMap<ChatMessage, { width: number; focused: boolean; rows: string[] }>();

export function transcriptRows(options: {
  messages: readonly ChatMessage[];
  streamingText?: string;
  busy?: boolean;
  status?: string;
  width: number;
  height: number;
  focusedMessageIndex?: number;
}): TranscriptRow[] {
  const width = Math.max(10, options.width - 2);
  const collected: string[] = [];
  options.messages.forEach((message, index) => {
    const focused = options.focusedMessageIndex === index;
    const cached = rowCache.get(message);
    const rows = cached && cached.width === width && cached.focused === focused
      ? cached.rows
      : messageRows(message, width, focused);
    if (!cached || cached.width !== width || cached.focused !== focused) {
      rowCache.set(message, { width, focused, rows });
    }
    collected.push(...rows);
  });
  if (options.streamingText) {
    const tail = streamingPreviewTail(options.streamingText);
    collected.push("", ...rowsFor(`⏺ ${tail}`, width));
  }
  if (options.busy) collected.push(options.status || "Working…");
  const hidden = Math.max(0, collected.length - options.height);
  const visible = hidden > 0 ? collected.slice(-options.height) : collected;
  if (hidden > 0 && visible.length > 0) visible[0] = `… ${hidden} earlier rows`;
  return visible.map((text, index) => ({ key: `row-${hidden + index}`, text }));
}
