import type { ChatMessage, TuiState } from "./state.ts";
import { parseMarkdownLines } from "./markdown-lines.ts";
import { toMessageRenderModel } from "./render-model.ts";
import type { RenderLine } from "./render-lines.ts";
import { thinkingRenderLines } from "./thinking-lines.ts";
import { todoPanelRenderLines } from "./todo-lines.ts";
import { toolVisualName, toolVisualStatusIcon } from "./tool-lines.ts";
import { terminalStringWidth } from "./terminal-width.ts";
import { autocompleteRenderLines, panelBottomLine, panelContentLine, panelTopLine, permissionPanelRenderLines, planApprovalRenderLines } from "./terminal-overlay-lines.ts";
import type { TerminalAutocompleteState } from "./terminal-autocomplete-controller.ts";
import { noticeText, noticeTitle, permissionModeLabel, statusLabel, toolArgumentSummary } from "./claude-style.ts";

export type TerminalRenderOptions = {
  maxMessages?: number;
  includeStatus?: boolean;
  /** Claude Code-style condensed session header. Disabled unless supplied. */
  header?: {
    title?: string;
    cwd?: string;
    show?: boolean;
  };
  /** Draw the thin separator immediately above the prompt row. */
  promptRule?: boolean;
  /** Terminal width used for deterministic line wrapping. */
  width?: number;
  /** Optional total frame height; the prompt footer is pinned to the bottom. */
  height?: number;
  /**
   * Main-screen mode: completed transcript rows are append-only and all
   * transient rows are marked for the renderer's live tail. This intentionally
   * leaves `height` unset so messages flow into terminal scrollback.
   */
  scrollback?: boolean;
  /** Rows below the viewport, matching TuiState.scrollOffset semantics. */
  scrollOffset?: number;
  /** Input value and grapheme cursor rendered as the final frame rows. */
  input?: string;
  cursor?: number;
  autocomplete?: TerminalAutocompleteState;
  maskInput?: boolean;
};

/**
 * Build the complete chat frame as presentation data only. This is the
 * boundary used by the standalone ANSI entrypoint; it never mutates TuiState.
 */
export function buildTerminalRenderLines(
  state: TuiState,
  options: TerminalRenderOptions = {},
): RenderLine[] {
  const lines: RenderLine[] = [];

  const width = options.width === undefined ? undefined : Math.max(10, options.width);
  const scrollback = options.scrollback === true;
  // Main-screen transcript mode must keep every completed message in order.
  // Applying the fullscreen 200-message viewport cap here would shift the
  // first committed row after message 200 and make the append-only renderer
  // emit the preceding history again as a new segment.
  const messageStart = scrollback
    ? 0
    : Math.max(0, state.messages.length - (options.maxMessages ?? 200));
  const header = options.header?.show === false ? [] : options.header ? headerRenderLines(state, options.header) : [];

  // Fullscreen keeps the task panel above the message feed. In main-screen
  // mode it belongs to the live tail so Todo updates never require rewriting
  // already committed transcript rows in terminal scrollback.
  const panelLines = todoPanelRenderLines({
    plan: state.todoPlan,
    todos: state.todoItems,
    viewMode: state.todoViewMode,
  }).map((line) => ({ ...line, key: `panel-${line.key}` }));
  const panelLinesAboveBody = scrollback ? [] : panelLines;
  const panelLinesInLiveTail = scrollback ? panelLines.map(markEphemeral) : [];

  for (let index = messageStart; index < state.messages.length; index++) {
    const message = state.messages[index]!;
    const visual = toMessageRenderModel(message);
    addMessageGap(lines, index);
    if (message.kind === "user") {
      lines.push({ key: `message-${index}`, text: truncateUserText(visual.text), prefix: "❯ ", style: "user", background: "user", fillWidth: width });
      for (const [imageIndex, image] of (message.images ?? []).entries()) {
        lines.push({
          key: `message-${index}-image-${imageIndex}`,
          text: `[image: ${image.path.split("/").pop() ?? image.path}]`,
          prefix: "  ",
          style: "muted",
          dim: true,
        });
      }
      continue;
    }
    if (message.kind === "assistant") {
      // Focus highlighting is a fullscreen interaction. Main-screen history
      // is append-only, so toggling focus must not rewrite old scrollback.
      const focused = !scrollback && state.focusedMessageIndex === index;
      const reasoning = message.reasoning;
      const showReasoning = Boolean(reasoning && (state.thinkingMode !== "hidden" || state.expandedThinking.includes(index)));
      if (showReasoning) {
        if (focused) {
          lines.push({
            key: `message-${index}-marker`,
            text: "◆ ",
            style: "assistant",
            tone: "running",
            bold: true,
          });
        }
        lines.push(...thinkingHeaderLines(reasoning!, state.thinkingMode, false, index, focused));
        lines.push(...thinkingRenderLines(reasoning!, {
          mode: state.thinkingMode,
          forceExpanded: state.expandedThinking.includes(index),
        }).map((line, lineIndex) => ({
          ...line,
          key: `message-${index}-${line.key}`,
          tone: focused ? "running" as const : line.tone,
          prefix: focused ? "│ " : "  ",
        })));
      }
      if (message.text) {
        const textLines = markdownLines(message.text, `message-${index}-text`);
        textLines.forEach((line, lineIndex) => {
          line.prefix = lineIndex === 0 ? `${focused ? "◆" : "⏺"} ` : "  ";
          line.tone = focused ? "running" : line.tone;
        });
        lines.push(...textLines);
      }
      continue;
    }
    if (message.kind === "tool_call") {
      // Claude Code's main-screen transcript uses compact activity rows; the
      // bordered tool card remains available in fullscreen mode.
      lines.push(...toolCardRenderLines(message, index, scrollback ? undefined : width));
      continue;
    }
    if (message.kind === "notice") {
      const title = noticeTitle(message.title);
      if (title) lines.push({ key: `message-${index}-title`, text: `── ${title} ──`, style: "border", bold: true });
      lines.push(...plainPreviewLines(noticeText(message.text), `message-${index}-notice`).map((line) => ({ ...line, prefix: "  " })));
      continue;
    }
    if (message.kind === "subagent_call") {
      const tone = message.status === "error" ? "error" : message.status === "running" ? "running" : "success";
      lines.push({
        key: `message-${index}-subagent`,
        text: `${message.profile ?? "Agent"} (${message.task})`,
        prefix: message.status === "error" ? "✗ " : "⏺ ",
        style: "tool",
        tone,
        bold: true,
      });
      if (message.result) {
        lines.push(...plainPreviewLines(message.result, `message-${index}-subagent-result`).map((line, lineIndex) => ({
          ...line,
          prefix: lineIndex === 0 ? "  ⎿ " : "     ",
        })));
      }
      continue;
    }
    lines.push({ key: `message-${index}-error`, text: message.text, prefix: "✗ ", style: "error", tone: "error" });
  }

  if (state.streamingReasoning) {
    addMessageGap(lines, state.messages.length);
    lines.push(...thinkingHeaderLines(state.streamingReasoning, state.thinkingMode, state.busy, "streaming", false).map((line) => scrollback ? markEphemeral(line) : line));
    lines.push(...thinkingRenderLines(state.streamingReasoning, {
      mode: state.thinkingMode,
      isStreaming: state.busy,
      streamInfo: state.busy ? " streaming" : undefined,
    }).map((line) => {
      const next = { ...line, key: `streaming-${line.key}`, prefix: "  " };
      return scrollback ? markEphemeral(next) : next;
    }));
  }
  if (state.streamingText) {
    addMessageGap(lines, state.messages.length + 1);
    lines.push({ key: "streaming-text", text: state.streamingText, prefix: "⏺ ", style: "assistant", ...(scrollback ? { ephemeral: true } : {}) });
  }
  const wrappedPanel = width === undefined ? panelLinesAboveBody : panelLinesAboveBody.flatMap((line) => wrapRenderLine(line, width));
  const bodyLines = scrollback ? lines.map((line) => line.tone === "running" ? markEphemeral(line) : line) : lines;
  const wrappedBody = width === undefined ? bodyLines : bodyLines.flatMap((line) => wrapRenderLine(line, width));
  const wrappedHeader = width === undefined ? header : header.flatMap((line) => wrapRenderLine(line, width));
  const footer: RenderLine[] = [];
  footer.push(...panelLinesInLiveTail);
  footer.push(...autocompleteRenderLines(options.autocomplete));
  footer.push(...permissionPanelRenderLines(state.pendingPermission, width));
  footer.push(...planApprovalRenderLines(state.phase === "review" ? state.currentPlan : undefined, width));
  for (const [index, image] of state.pendingImages.entries()) {
    footer.push({
      key: `pending-image-${index}`,
      text: image.path.split("/").pop() ?? image.path,
      prefix: "🖼 ",
      style: "user",
      dim: true,
    });
  }
  if (state.spinnerMessage) footer.push({ key: "spinner", text: state.spinnerMessage, prefix: "✻ ", style: "muted", dim: true });
  if (options.includeStatus !== false) {
    const cwd = options.header?.cwd?.trim();
    const mode = permissionModeLabel(state.permissionMode);
    const visibleStatus = statusLabel(state.status, state.busy);
    const fixedContext = `${state.modelName} · ${mode} · ${visibleStatus}`;
    const pathBudget = width === undefined || !cwd
      ? undefined
      : Math.max(8, width - terminalStringWidth(fixedContext) - 6);
    const visibleCwd = cwd && pathBudget !== undefined ? truncateTail(cwd, pathBudget) : cwd;
    const context = [state.modelName, ...(visibleCwd ? [visibleCwd] : []), mode, visibleStatus].join(" · ");
    const statusPrefix = state.busy ? "⟳ " : "· ";
    const stableContext = width === undefined
      ? context
      : truncateTail(context, Math.max(1, width - terminalStringWidth(statusPrefix)));
    footer.push({ key: "status", text: stableContext, prefix: statusPrefix, style: "muted", tone: state.busy ? "running" : "default", dim: true });
  }
  if (options.promptRule && width !== undefined) {
    footer.push({ key: "prompt-rule", text: "─".repeat(Math.max(1, width)), style: "border", dim: true });
  }
  if (options.input !== undefined) {
    const inputLines = inputRenderLines(options.input, options.cursor, options.maskInput);
    footer.push(...(width === undefined ? inputLines : inputLines.flatMap((line) => wrapRenderLine(line, width))));
  }
  const visibleFooter = scrollback ? footer.map(markEphemeral) : footer;

  if (options.height === undefined) return [...wrappedHeader, ...wrappedPanel, ...wrappedBody, ...visibleFooter];
  const height = Math.max(1, options.height);
  // Reserve the footer first so the prompt remains anchored at the bottom of
  // the frame. On very short terminals this intentionally drops header/body
  // rows before it drops the latest input and status rows.
  const clippedFooter = visibleFooter.slice(-Math.min(visibleFooter.length, height));
  let remaining = Math.max(0, height - clippedFooter.length);
  const visibleHeader = wrappedHeader.slice(0, remaining);
  remaining = Math.max(0, remaining - visibleHeader.length);
  const visiblePanel = wrappedPanel.slice(0, remaining);
  remaining = Math.max(0, remaining - visiblePanel.length);
  const bodyHeight = remaining;
  const offset = Math.max(0, options.scrollOffset ?? 0);
  const end = Math.max(0, wrappedBody.length - offset);
  const cropStart = Math.max(0, end - bodyHeight);
  const clipped = wrappedBody.slice(cropStart, end);
  // Keep a stable number of physical rows. Apart from making the prompt feel
  // fixed to the bottom, this prevents terminal resize and streaming updates
  // from leaving stale content below a shorter frame. Hidden rows stay hidden;
  // Claude Code does not replace conversation content with a row-count hint.
  while (clipped.length < bodyHeight) {
    clipped.push({ key: `frame-spacer-${clipped.length}`, text: "", style: "muted" });
  }
  return [...visibleHeader, ...visiblePanel, ...clipped, ...clippedFooter];
}

function truncateTail(value: string, maxWidth: number): string {
  if (terminalStringWidth(value) <= maxWidth) return value;
  const suffixWidth = Math.max(1, maxWidth - 1);
  let suffix = "";
  let used = 0;
  for (const grapheme of [...value].reverse()) {
    const glyphWidth = Math.max(1, terminalStringWidth(grapheme));
    if (used + glyphWidth > suffixWidth) break;
    suffix = grapheme + suffix;
    used += glyphWidth;
  }
  return `…${suffix}`;
}

function addMessageGap(lines: RenderLine[], messageIndex: number | string): void {
  if (lines.length === 0 || lines.at(-1)?.text === "") return;
  lines.push({ key: `message-gap-${messageIndex}`, text: "", style: "muted" });
}

function markEphemeral(line: RenderLine): RenderLine {
  return line.ephemeral ? line : { ...line, ephemeral: true };
}

function toolCardRenderLines(
  message: Extract<ChatMessage, { kind: "tool_call" }>,
  index: number,
  width?: number,
): RenderLine[] {
  // Claude Code renders the shell command itself inside the tool title rather
  // than adding a second `$` prompt inside the parentheses.
  const summary = toolArgumentSummary(message.name, message.rawArgs, message.args).replace(/^\$\s*/, "");
  const duration = message.durationMs === undefined ? "" : ` · ${message.durationMs}ms`;
  const tone = message.status === "error" ? "error" : message.status === "running" ? "running" : "success";
  const label = `${toolVisualName(message.name)}${summary ? `(${summary})` : ""}${duration}`;
  const title = `${toolVisualStatusIcon(message.status)} ${label}`;
  if (width === undefined) {
    const marker = message.status === "error" ? "✗ " : "⏺ ";
    const rows: RenderLine[] = [{
      key: `message-${index}-tool`,
      text: label,
      prefix: marker,
      style: "tool",
      tone,
      bold: true,
    }];
    if (message.result) {
      rows.push(...plainPreviewLines(message.result, `message-${index}-result`).map((line, lineIndex) => ({
        ...line,
        // Claude Code's MessageResponse uses one nested result marker and
        // plain continuation indentation instead of a box-drawing column.
        prefix: lineIndex === 0 ? "  ⎿ " : "     ",
      })));
    } else if (message.status === "running") {
      rows.push({ key: `message-${index}-result-running`, text: "Working…", prefix: "  ⎿ ", style: "muted", tone: "running", dim: true });
    }
    return rows;
  }
  const rows: RenderLine[] = [panelTopLine(`message-${index}-tool`, title, width, tone)];
  if (message.result) {
    rows.push(...plainPreviewLines(message.result, `message-${index}-result`).map((line) => panelContentLine(line.key, line.text, "muted", { width, dim: true })));
  } else if (message.status === "running") {
    rows.push(panelContentLine(`message-${index}-result-running`, "Working…", "tool", { width, tone: "running", dim: true }));
  } else {
    rows.push(panelContentLine(`message-${index}-result-empty`, "No output", "muted", { width, dim: true }));
  }
  rows.push(panelBottomLine(`message-${index}-tool-bottom`, width));
  return rows;
}

function headerRenderLines(state: TuiState, options: NonNullable<TerminalRenderOptions["header"]>): RenderLine[] {
  // Claude Code keeps model and cwd in its footer/status chrome. The optional
  // title remains for compatibility with callers that explicitly request a
  // welcome row, but no project-specific identity leaks into the transcript.
  const title = options.title ?? "Claude Code";
  return [{ key: "header-title", text: title, prefix: "✻ ", style: "assistant", bold: true, tone: "running" }];
}

function thinkingHeaderLines(content: string, mode: TuiState["thinkingMode"], streaming: boolean, key: number | string, focused: boolean): RenderLine[] {
  if (mode === "hidden") return [];
  const label = streaming ? "∴ Thinking…" : mode === "summary" && content.split("\n").length > 3 ? "∴ Thinking ▸ (Alt+T)" : "∴ Thinking…";
  return [{ key: `thinking-header-${key}`, text: label, prefix: focused ? "│ " : "  ", style: "thinking", dim: true, italic: true }];
}

function wrapRenderLine(line: RenderLine, width: number): RenderLine[] {
  const available = Math.max(1, width - (line.indent ?? 0) - terminalStringWidth(line.prefix ?? ""));
  const source = line.text || " ";
  const rows: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const grapheme of splitGraphemes(source)) {
    if (grapheme === "\n") {
      rows.push(current);
      current = "";
      currentWidth = 0;
      continue;
    }
    const glyphWidth = Math.max(1, terminalStringWidth(grapheme));
    if (current && currentWidth + glyphWidth > available) {
      rows.push(current);
      current = "";
      currentWidth = 0;
    }
    current += grapheme;
    currentWidth += glyphWidth;
  }
  rows.push(current);
  // Keep the logical line identity on the first wrapped row. This lets the
  // incremental renderer reuse unchanged rows while still giving continuation
  // rows deterministic identities of their own.
  const continuationPrefix = " ".repeat(terminalStringWidth(line.prefix ?? ""));
  return rows.map((text, index) => ({
    ...line,
    key: index === 0 ? line.key : `${line.key}-w${index}`,
    prefix: index === 0 ? line.prefix : continuationPrefix,
    text,
  }));
}

function inputRenderLines(value: string, cursor?: number, mask = false): RenderLine[] {
  const source = splitGraphemes(value);
  const position = Math.max(0, Math.min(source.length, cursor ?? source.length));
  const visible = mask ? source.map(() => "*") : source;
  const withCursor = [...visible.slice(0, position), "▌", ...visible.slice(position)].join("");
  const rows = withCursor.split("\n");
  return rows.map((text, index) => ({
    key: `input-${index}`,
    prefix: index === 0 ? "❯ " : "  ",
    text,
    style: "assistant",
    bold: index === 0,
  }));
}

function splitGraphemes(value: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return [...segmenter.segment(value)].map((part) => part.segment);
  }
  return [...value];
}

function markdownLines(text: string, prefix: string): RenderLine[] {
  return parseMarkdownLines(text).map((line, index) => ({
    key: `${prefix}-${index}`,
    text: line.kind === "rule" ? "─".repeat(48) : line.kind === "heading" ? line.text : line.kind === "list" ? `${line.ordered ? line.marker : "•"} ${line.text}` : line.kind === "quote" ? `│ ${line.text}` : line.text,
    style: line.kind === "code" || line.kind === "code-fence" ? "thinking" : line.kind === "heading" ? "assistant" : "assistant",
    indent: line.kind === "list" ? line.indent * 2 : undefined,
    bold: line.kind === "heading",
    dim: line.kind === "code" || line.kind === "code-fence",
  }));
}

function plainPreviewLines(text: string, prefix: string): RenderLine[] {
  const source = text.split("\n");
  const visible = source.slice(0, 15).map((line, index) => ({ key: `${prefix}-${index}`, text: line, style: "muted" as const, dim: true }));
  if (source.length > visible.length) visible.push({ key: `${prefix}-more`, text: `… ${source.length - visible.length} more lines`, style: "muted" as const, dim: true });
  return visible;
}

const MAX_USER_DISPLAY_CHARS = 10_000;
const USER_DISPLAY_HEAD_CHARS = 2_500;
const USER_DISPLAY_TAIL_CHARS = 2_500;

/** Keep pasted files from turning one prompt into an unbounded transcript row. */
function truncateUserText(text: string): string {
  if (text.length <= MAX_USER_DISPLAY_CHARS) return text;
  const head = text.slice(0, USER_DISPLAY_HEAD_CHARS);
  const tail = text.slice(-USER_DISPLAY_TAIL_CHARS);
  const headLines = (head.match(/\n/g) ?? []).length;
  const tailLines = (tail.match(/\n/g) ?? []).length;
  const hiddenLines = Math.max(0, (text.match(/\n/g) ?? []).length - headLines - tailLines);
  return `${head}\n… +${hiddenLines} lines …\n${tail}`;
}
