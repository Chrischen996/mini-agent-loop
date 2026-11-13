import type { ChatMessage, ThinkingDisplayMode } from "./state.ts";
import { noticeText, noticeTitle, toolArgumentSummary } from "./claude-style.ts";
import { CODE_GUTTER, markdownRowText, markdownRuleText, parseMarkdownLines, stripInlineMarkdown } from "./markdown-lines.ts";
import { highlightCodeLine, type CodeSpan } from "./code-highlight.ts";
import { isSubagentProtocolText, isSubagentToolName, subagentRenderLines } from "./subagent-lines.ts";
import { toolVisualName, toolVisualStatusIcon } from "./tool-lines.ts";
import { buildToolResultRows } from "./tool-result-lines.ts";
import { thinkingRenderLines, thinkingVisibleLines } from "./thinking-lines.ts";
import { RESULT_GUTTER, type RenderLine } from "./render-lines.ts";
import { terminalStringWidth, wrapTerminalLine } from "./terminal-width.ts";
import { compactStreamingText, stripLeadingBlankLines } from "./text-utils.ts";

/**
 * Physical transcript rows shared by the Ink feed and scroll accounting.
 *
 * The feed used to let Ink lay out whole markdown trees inside `overflow`
 * boxes with negative top margins. Ink's clipping applies only the innermost
 * clip, so a scrolled block escaped its slice and overwrote other frame rows
 * (most visibly while scrolling up). Projection here pre-wraps every block
 * into the exact physical rows a terminal shows, so the feed can slice plain
 * arrays — no nested clipping, no negative margins — and the viewport counts
 * the very same arrays, ending row-estimate drift for CJK/emoji/markdown.
 */

export type PhysicalRow = {
  key: string;
  text: string;
  style: RenderLine["style"];
  tone?: RenderLine["tone"];
  dim?: boolean;
  bold?: boolean;
  italic?: boolean;
  /** Token runs for syntax-highlighted rows (fenced code). */
  spans?: readonly CodeSpan[];
};

/** Marker + body column budget for assistant/user blocks inside the feed. */
function bodyWidth(width: number): number {
  // feed paddingX={1} (2 cols) + "⏺ " marker (2 cols)
  return Math.max(10, width - 4);
}

function blankRow(key: string): PhysicalRow {
  return { key, text: "", style: "assistant" };
}

function pushWrapped(rows: PhysicalRow[], line: RenderLine, keyPrefix: string, width: number, indentColumn = 0): void {
  const prefix = `${" ".repeat(Math.max(0, line.indent ?? 0))}${line.prefix ?? ""}`;
  const available = Math.max(1, width - terminalStringWidth(prefix) - indentColumn);
  wrapTerminalLine(line.text, available).forEach((text, rowIndex) => {
    rows.push({
      key: `${keyPrefix}-${line.key}-${rowIndex}`,
      text: rowIndex === 0 && prefix ? `${prefix}${text}` : (prefix ? prefix : "") + text,
      style: line.style,
      tone: line.tone,
      dim: line.dim,
      bold: line.bold,
      italic: line.italic,
    });
  });
}

/** Physical rows for one assistant block: thinking + markdown body. */
function assistantBodyRows(
  message: Extract<ChatMessage, { kind: "assistant" }>,
  index: number,
  options: { width: number; thinkingMode: ThinkingDisplayMode; expanded: boolean; focused: boolean },
): PhysicalRow[] {
  const rows: PhysicalRow[] = [];
  const budget = bodyWidth(options.width);
  if (message.reasoning) {
    const visible = thinkingVisibleLines(message.reasoning, { mode: options.thinkingMode, forceExpanded: options.expanded });
    if (visible.expanded) {
      rows.push({
        key: `message-${index}-thinking-header`,
        text: "∴ Thinking…",
        style: "thinking",
        italic: true,
        dim: true,
      });
      for (const line of thinkingRenderLines(message.reasoning, { mode: options.thinkingMode, forceExpanded: options.expanded })) {
        // ThinkingBlock wraps each line inside paddingLeft={2}; the shared
        // budget already subtracts the feed padding + marker, so wrap at the
        // remaining width with the two-column gutter as continuation column.
        const physical = wrapTerminalLine(line.text, budget);
        physical.forEach((text, rowIndex) => {
          rows.push({
            key: `message-${index}-think-${line.key}-${rowIndex}`,
            text: rowIndex === 0 ? text : `  ${text}`,
            style: line.style,
            dim: true,
          });
        });
      }
    } else if (options.thinkingMode !== "hidden") {
      rows.push({
        key: `message-${index}-thinking-hint`,
        text: "∴ Thinking ▸",
        style: "thinking",
        italic: true,
        dim: true,
      });
    }
  }
  if (message.text) {
    let fenceLang = "";
    parseMarkdownLines(message.text).forEach((line, lineIndex) => {
      const key = `message-${index}-md-${lineIndex}`;
      switch (line.kind) {
        case "code-fence": {
          // Fence marker rows: keep the gutter + optional language label,
          // and remember the language for the body rows that follow.
          const fenceText = markdownRowText(line);
          fenceLang = line.opening ? line.lang : "";
          rows.push({
            key: `${key}-0`,
            text: fenceText,
            style: "thinking",
            dim: true,
            spans: [{ text: fenceText, kind: "gutter" }],
          });
          break;
        }
        case "code": {
          const body = line.text;
          const spans: CodeSpan[] = [{ text: `${CODE_GUTTER} `, kind: "gutter" }, ...highlightCodeLine(body, fenceLang)];
          rows.push({ key: `${key}-0`, text: `${CODE_GUTTER} ${body}`, style: "thinking", spans });
          break;
        }
        case "heading":
          wrapTerminalLine(stripInlineMarkdown(line.text), budget).forEach((text, rowIndex) => {
            rows.push({
              key: `${key}-${rowIndex}`,
              text: `${line.level <= 2 ? "▸" : "·"} ${text}`,
              style: "assistant",
              bold: true,
            });
          });
          break;
        case "rule":
          rows.push({ key: `${key}-0`, text: markdownRuleText(options.width), style: "border", dim: true });
          break;
        case "quote":
          wrapTerminalLine(stripInlineMarkdown(line.text), Math.max(1, budget - 2)).forEach((text, rowIndex) => {
            rows.push({ key: `${key}-${rowIndex}`, text: `│ ${text}`, style: "assistant", dim: true });
          });
          break;
        case "table":
          rows.push({ key: `${key}-0`, text: line.text, style: "assistant", dim: line.role === "rule" });
          break;
        case "list": {
          const marker = line.ordered ? line.marker : "•";
          const gutter = `${" ".repeat(line.indent * 2)}${marker} `;
          const available = Math.max(1, budget - terminalStringWidth(gutter));
          wrapTerminalLine(stripInlineMarkdown(line.text), available).forEach((text, rowIndex) => {
            rows.push({
              key: `${key}-${rowIndex}`,
              text: rowIndex === 0 ? `${gutter}${text}` : `${" ".repeat(terminalStringWidth(gutter))}${text}`,
              style: "assistant",
            });
          });
          break;
        }
        default: {
          const plain = stripInlineMarkdown(line.text);
          // Ink renders an empty <Text> as zero rows; keep the projection
          // consistent so blank markdown lines cost nothing.
          if (!plain) return;
          wrapTerminalLine(plain, budget).forEach((text, rowIndex) => {
            rows.push({ key: `${key}-${rowIndex}`, text, style: "assistant" });
          });
        }
      }
    });
  }
  return rows;
}

/**
 * Physical rows for one completed history block, including its 1-row gap.
 * Tool-only assistant turns and subagent protocol rows render zero rows.
 */
export function messagePhysicalRows(
  message: ChatMessage,
  index: number,
  options: {
    width: number;
    thinkingMode: ThinkingDisplayMode;
    expanded: boolean;
    focused: boolean;
  },
): PhysicalRow[] {
  const { width } = options;
  if (message.kind === "assistant" && isSubagentProtocolText(message.text)) return [];
  if (message.kind === "tool_call" && isSubagentToolName(message.name)) return [];
  const rows: PhysicalRow[] = [blankRow(`message-${index}-gap`)];
  switch (message.kind) {
    case "user": {
      const text = message.displayText ?? message.text;
      wrapTerminalLine(text, bodyWidth(width)).forEach((line, rowIndex) => {
        rows.push({ key: `message-${index}-user-${rowIndex}`, text: line, style: "user" });
      });
      message.images?.forEach((image, imageIndex) => {
        rows.push({
          key: `message-${index}-image-${imageIndex}`,
          text: `[image: ${image.path.split("/").pop() ?? image.path}]`,
          style: "muted",
          dim: true,
        });
      });
      return rows;
    }
    case "assistant": {
      if (!message.reasoning && !message.text) return [];
      rows.push(...assistantBodyRows(message, index, options));
      return rows;
    }
    case "tool_call": {
      const argument = toolArgumentSummary(message.name, message.rawArgs, message.args).replace(/^\$\s*/, "");
      const label = `${toolVisualStatusIcon(message.status)} ${toolVisualName(message.name)}${argument ? `(${argument})` : ""}`;
      wrapTerminalLine(label, Math.max(1, width - 2)).forEach((text, rowIndex) => {
        rows.push({ key: `message-${index}-tool-${rowIndex}`, text, style: "tool", bold: true });
      });
      const resultRows = message.result ? buildToolResultRows(message.result) : [];
      resultRows.forEach((row, rowIndex) => {
        rows.push({
          key: `message-${index}-result-${rowIndex}`,
          text: `${RESULT_GUTTER}${row.text}`,
          style: "muted",
          tone: row.tone,
          dim: row.dim,
        });
      });
      if (!message.result && message.status === "running") {
        rows.push({ key: `message-${index}-running`, text: `${RESULT_GUTTER}Working…`, style: "muted", tone: "running", dim: true });
      }
      return rows;
    }
    case "notice": {
      const title = noticeTitle(message.title);
      if (title) rows.push({ key: `message-${index}-title`, text: title, style: "border", bold: true });
      noticeText(message.text).split("\n").forEach((line, rowIndex) => {
        rows.push({ key: `message-${index}-notice-${rowIndex}`, text: line, style: "muted", dim: true });
      });
      return rows;
    }
    case "subagent_call": {
      for (const line of subagentRenderLines(message, index, { width })) {
        pushWrapped(rows, line, `message-${index}`, width);
      }
      return rows;
    }
    case "error": {
      wrapTerminalLine(message.text, bodyWidth(width)).forEach((text, rowIndex) => {
        rows.push({ key: `message-${index}-error-${rowIndex}`, text: `✗ ${text}`, style: "error" });
      });
      return rows;
    }
  }
}

/** Live-stack preview rows while a turn is streaming (no leading gap). */
export function streamingPhysicalRows(options: {
  streamingText: string;
  streamingReasoning: string;
  busy: boolean;
  width: number;
  reasoningMode: ThinkingDisplayMode;
}): PhysicalRow[] {
  const rows: PhysicalRow[] = [];
  const budget = bodyWidth(options.width);
  if (options.streamingReasoning) {
    rows.push({ key: "streaming-thinking-header", text: "∴ Thinking ▸", style: "thinking", italic: true, dim: true });
  }
  if (options.streamingText) {
    const display = stripLeadingBlankLines(
      options.busy
        ? compactStreamingText(stripInlineMarkdown(options.streamingText))
        : stripInlineMarkdown(options.streamingText),
    );
    const physical = wrapTerminalLine(display, budget);
    if (physical.length === 1 && physical[0] === "") physical[0] = " ";
    physical.forEach((text, rowIndex) => {
      rows.push({ key: `streaming-text-${rowIndex}`, text, style: "assistant" });
    });
  }
  return rows;
}
