import type { ChatMessage, TuiState } from "./state.ts";
import { markdownRowText, markdownRuleText, parseMarkdownLines, stripInlineMarkdown } from "./markdown-lines.ts";
import { toMessageRenderModel } from "./render-model.ts";
import type { RenderLine } from "./render-lines.ts";
import { thinkingRenderLines } from "./thinking-lines.ts";
import { todoPanelRenderLines } from "./todo-lines.ts";
import { toolVisualName, toolVisualStatusIcon } from "./tool-lines.ts";
import { terminalStringWidth } from "./terminal-width.ts";
import { autocompleteRenderLines, permissionPanelRenderLines, planApprovalRenderLines, todoEditorRenderLines } from "./terminal-overlay-lines.ts";
import { pickerChromeRows } from "./picker-window.ts";
import type { TerminalAutocompleteState } from "./terminal-autocomplete-controller.ts";
import type { TodoEditorState } from "./todo-editor.ts";
import { noticeText, noticeTitle, toolArgumentSummary } from "./claude-style.ts";
import { buildStatusSegments } from "./status-line.ts";
import type { ModelThinkingLevel } from "../pi-ai/types.ts";
import { isSubagentProtocolText, isSubagentToolName, subagentRenderLines } from "./subagent-lines.ts";
import { activityPresentation, formatActivity, loadingGlyph } from "./activity.ts";
import { TUI_BRAND_MARK, TUI_BRAND_NAME, TUI_BRAND_SPARK } from "./brand.ts";
import { welcomePanelRenderLines, type WelcomePanelData } from "./welcome-panel.ts";
import { compactStreamingText } from "./text-utils.ts";

export type TerminalRenderOptions = {
  maxMessages?: number;
  includeStatus?: boolean;
  /** Claude Code-style condensed session header. Disabled unless supplied. */
  header?: {
    title?: string;
    version?: string;
    model?: string;
    billing?: string;
    cwd?: string;
    show?: boolean;
    showWelcome?: boolean;
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
  /** Active `provider/model` reference; the model picker marks it with a ✓. */
  currentModel?: string;
  maskInput?: boolean;
  /** Current clock sample for deterministic activity rendering and tests. */
  now?: number;
  /** Active model context window shown in the stable LLM metadata row. */
  contextWindow?: number;
  queuedCount?: number;
  /** Active reasoning level shown in the wide status row. */
  thinkingLevel?: ModelThinkingLevel;
  /** Optional Todo editor overlay owned by the standalone terminal entrypoint. */
  todoEditor?: TodoEditorState;
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
  const header = options.header?.show === false ? [] : options.header ? headerRenderLines(state, options.header, width) : [];

  // Fullscreen keeps the task panel above the message feed. In main-screen
  // mode it belongs to the live tail so Todo updates never require rewriting
  // already committed transcript rows in terminal scrollback.
  const panelLines = todoPanelRenderLines({
    plan: state.todoPlan,
    todos: state.todoItems,
    viewMode: state.todoViewMode,
    maxVisibleItems: Math.max(3, Math.min(8, (options.height ?? 24) - 4)),
  }).map((line) => ({ ...line, key: `panel-${line.key}` }));
  const panelLinesAboveBody = scrollback ? [] : panelLines;
  const panelLinesInLiveTail = scrollback ? panelLines.map(markEphemeral) : [];

  for (let index = messageStart; index < state.messages.length; index++) {
    const message = state.messages[index]!;
    if (message.kind === "assistant" && isSubagentProtocolText(message.text)) continue;
    const visual = toMessageRenderModel(message);
    // Keep the transcript airy at conversation boundaries, while tool and
    // subagent progress rows stay attached to the assistant turn that caused
    // them. This removes the staircase of blank rows visible during a busy
    // run without changing any message ordering.
    if (message.kind !== "tool_call" && (index === messageStart || state.messages[index - 1]?.kind !== "tool_call")) {
      addMessageGap(lines, index);
    }
    if (message.kind === "user") {
      // Claude Code keeps the prompt body white on a muted gray row. The
      // prompt marker is intentionally quiet; user text should not inherit
      // the blue metadata color used by the model/context chrome.
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
        const textLines = markdownLines(message.text, `message-${index}-text`, width);
        textLines.forEach((line, lineIndex) => {
          line.prefix = lineIndex === 0 ? `${focused ? "◆" : "⏺"} ` : "  ";
          line.tone = focused ? "running" : line.tone;
        });
        lines.push(...textLines);
      }
      continue;
    }
    if (message.kind === "tool_call") {
      // The subagent lifecycle has its own progress projection below. The
      // protocol-level tool call would otherwise duplicate the same action
      // and expose its internal task schema in the transcript.
      if (isSubagentToolName(message.name)) continue;
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
      lines.push(...subagentRenderLines(message, index, { width }));
      continue;
    }
    // Keep the error marker red while leaving the diagnostic readable. A full
    // red row becomes visually dominant when a provider returns a long error.
    lines.push({ key: `message-${index}-error`, text: message.text, prefix: "✗ ", style: "assistant", prefixTone: "error" });
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
    const streamingText = state.busy
      ? compactStreamingText(stripInlineMarkdown(state.streamingText))
      : stripInlineMarkdown(state.streamingText);
    lines.push({ key: "streaming-text", text: streamingText, prefix: "⏺ ", style: "assistant", ...(scrollback ? { ephemeral: true } : {}) });
  }
  const wrappedPanel = width === undefined ? panelLinesAboveBody : panelLinesAboveBody.flatMap((line) => wrapRenderLine(line, width));
  const bodyLines = scrollback ? lines.map((line) => line.tone === "running" ? markEphemeral(line) : line) : lines;
  const wrappedBody = width === undefined ? bodyLines : bodyLines.flatMap((line) => wrapRenderLine(line, width));
  const wrappedHeader = width === undefined ? header : header.flatMap((line) => wrapRenderLine(line, width));
  const footer: RenderLine[] = [];
  footer.push(...panelLinesInLiveTail);
  // Slot reserved for the picker or the Todo editor. The picker is filled in
  // once the rest of the frame is known: fullscreen modes reserve the welcome
  // panel and the prompt chrome first and hand the overlay what is left, so a
  // short terminal shrinks (or drops) the picker instead of cutting the panel
  // mid-border. That mirrors what `getPickerLayout` does for the Ink client.
  const overlaySlot = footer.length;
  if (options.todoEditor) footer.push(...todoEditorRenderLines(options.todoEditor, width));
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
  // The Todo tip is folded into the single activity row below; a second
  // spinner row above the prompt duplicated the same live state.
  const now = options.now ?? Date.now();
  const activity = activityPresentation({ ...state, todoPanelVisible: panelLines.length > 0 }, { now });
  if (activity) {
    const activityPrefix = `${loadingGlyph(now, state.turnStartedAt)} `;
    const activityWidth = width === undefined ? undefined : Math.max(1, width - terminalStringWidth(activityPrefix));
    footer.push({
      key: "activity",
      text: activityWidth === undefined ? formatActivity(activity) : truncateEnd(formatActivity(activity), activityWidth),
      prefix: activityPrefix,
      style: "muted",
      tone: activity.stalled ? "error" : "running",
      bold: true,
    });
  }
  if (options.includeStatus !== false) {
    // Shared with the Ink StatusBar: one segment list owns order, separators,
    // truncation, and colors so the two clients cannot drift apart again.
    const segments = buildStatusSegments({
      modelName: state.modelName,
      cwd: options.header?.cwd?.trim() || undefined,
      permissionMode: state.permissionMode,
      thinkingLevel: options.thinkingLevel,
      contextTokens: state.contextTokens,
      contextWindow: options.contextWindow,
      busy: state.busy,
      status: state.status,
      queuedCount: options.queuedCount,
      cacheReadTokens: state.cacheReadTokens,
      promptTokens: state.contextTokens,
      width,
    });
    footer.push({
      key: "status",
      text: segments.map((segment) => segment.text).join(""),
      segments,
      style: "muted",
      dim: true,
    });
  }
  if (options.promptRule && width !== undefined) {
    footer.push({ key: "prompt-rule", text: "─".repeat(Math.max(1, width)), style: "border", dim: true });
  }
  if (options.input !== undefined) {
    const inputLines = inputRenderLines(options.input, options.cursor, options.maskInput);
    footer.push(...(width === undefined ? inputLines : inputLines.flatMap((line) => wrapRenderLine(line, width))));
  }
  if (!options.todoEditor) {
    const reserved = wrappedHeader.length + wrappedPanel.length + footer.length;
    // The same budget the Ink client computes in `getPickerLayout`: keep the
    // last terminal row free, reserve the panel and the prompt chrome, and hold
    // three spare rows back before the picker claims them.
    const budget = options.height === undefined
      ? undefined
      : Math.max(1, options.height) - 1 - reserved - 3 - pickerChromeRows(options.autocomplete?.mode ?? undefined);
    footer.splice(overlaySlot, 0, ...autocompleteRenderLines(options.autocomplete, {
      input: options.input,
      currentModel: options.currentModel ?? options.header?.model,
      maxItems: budget,
    }));
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
  // Keep a stable number of physical rows without splitting the transcript.
  // Spare rows are inserted into the footer below the live activity so the
  // prompt remains anchored while message and subagent rows stay together.
  const padding = Math.max(0, bodyHeight - clipped.length);
  if (padding > 0) {
    const spacers = Array.from({ length: padding }, (_, index) => ({
      key: `frame-spacer-${index}`,
      text: "",
      style: "muted" as const,
    }));
    // Keep the transcript and the live activity contiguous. The spare rows
    // belong between activity metadata and the fixed prompt chrome; putting
    // them before the body makes old history look disconnected from the work
    // currently happening (especially with multiple subagents).
    const activityIndex = clippedFooter.findIndex((line) => line.key === "activity");
    const promptChromeIndex = clippedFooter.findIndex((line) => line.key === "status" || line.key === "prompt-rule" || line.key.startsWith("input-"));
    const insertAt = activityIndex >= 0
      ? activityIndex + 1
      : promptChromeIndex >= 0 ? promptChromeIndex : clippedFooter.length;
    clippedFooter.splice(insertAt, 0, ...spacers);
  }
  return [...visibleHeader, ...visiblePanel, ...clipped, ...clippedFooter];
}

function truncateEnd(value: string, maxWidth: number): string {
  if (terminalStringWidth(value) <= maxWidth) return value;
  if (maxWidth <= 1) return "…";
  let visible = "";
  let used = 0;
  for (const grapheme of value) {
    const glyphWidth = Math.max(1, terminalStringWidth(grapheme));
    if (used + glyphWidth > maxWidth - 1) break;
    visible += grapheme;
    used += glyphWidth;
  }
  return `${visible}…`;
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
  _width?: number,
): RenderLine[] {
  // One compact tool-use row plus a single nested result gutter, matching the
  // Ink feed and Claude Code's AssistantToolUseMessage/MessageResponse pair.
  // The fullscreen path used to draw a full-width three-row box for every tool
  // call, so the same run looked completely different between the two clients
  // (and buried the transcript under borders).
  const summary = toolArgumentSummary(message.name, message.rawArgs, message.args).replace(/^\$\s*/, "");
  const tone = message.status === "error" ? "error" : undefined;
  const prefixTone = message.status === "error" ? "error" : message.status === "running" ? "running" : "success";
  const label = `${toolVisualName(message.name)}${summary ? `(${summary})` : ""}`;
  const rows: RenderLine[] = [{
    key: `message-${index}-tool`,
    text: label,
    prefix: `${toolVisualStatusIcon(message.status)} `,
    style: "tool",
    tone,
    prefixTone,
    bold: true,
  }];
  if (message.result) {
    rows.push(...plainPreviewLines(message.result, `message-${index}-result`).map((line, lineIndex) => ({
      ...line,
      // One nested result marker, then plain continuation indentation instead
      // of a box-drawing column.
      prefix: lineIndex === 0 ? "  ⎿ " : "     ",
    })));
  } else if (message.status === "running") {
    rows.push({ key: `message-${index}-result-running`, text: "Working…", prefix: "  ⎿ ", style: "muted", tone: "running", dim: true });
  }
  return rows;
}

function headerRenderLines(
  state: TuiState,
  options: NonNullable<TerminalRenderOptions["header"]>,
  width: number | undefined,
): RenderLine[] {
  if (options.showWelcome && width !== undefined && width >= 70) {
    const welcome: WelcomePanelData = {
      title: options.title,
      version: options.version,
      model: options.model,
      billing: options.billing,
      cwd: options.cwd,
    };
    return welcomePanelRenderLines(width, welcome);
  }
  // Claude Code keeps model and cwd in its footer/status chrome. The optional
  // title remains for compatibility with callers that explicitly request a
  // welcome row, but no project-specific identity leaks into the transcript.
  const title = options.title ?? TUI_BRAND_NAME;
  return [
    { key: "header-spark-top", text: TUI_BRAND_SPARK, prefix: "  ", style: "assistant", bold: true, tone: "running" },
    { key: "header-title", text: title, prefix: `${TUI_BRAND_SPARK} ${TUI_BRAND_MARK} ${TUI_BRAND_SPARK}  `, prefixTone: "running", style: "assistant", bold: true },
    { key: "header-spark-bottom", text: TUI_BRAND_SPARK, prefix: "  ", style: "assistant", bold: true, tone: "running" },
  ];
}

function thinkingHeaderLines(content: string, mode: TuiState["thinkingMode"], streaming: boolean, key: number | string, focused: boolean): RenderLine[] {
  if (mode === "hidden") return [];
  const label = streaming && mode !== "full"
    ? "∴ Thinking ▸"
    : mode === "summary" && content.split("\n").length > 3
      ? "∴ Thinking ▸ (Alt+T)"
      : "∴ Thinking…";
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
  return rows.map((text, index) => {
    const wrapped: RenderLine = {
      ...line,
      key: index === 0 ? line.key : `${line.key}-w${index}`,
      prefix: index === 0 ? line.prefix : continuationPrefix,
      text,
    };
    // Inline color runs only describe the unwrapped row. Once a row is split
    // the segment boundaries no longer line up with the text, so fall back to
    // the single-color projection instead of repeating stale segments.
    if (rows.length > 1) delete wrapped.segments;
    return wrapped;
  });
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

/**
 * Project Markdown onto terminal rows.
 *
 * Row text comes from `markdownRowText` so the ANSI client and the Ink
 * `MarkdownText` component cannot drift: fenced code renders behind a `▌`
 * gutter instead of literal ``` markers, headings keep their `▸`/`·` bullet,
 * and tables arrive column-aligned instead of showing raw `| --- | --- |`.
 */
function markdownLines(text: string, prefix: string, width?: number): RenderLine[] {
  return parseMarkdownLines(text).map((line, index) => ({
    key: `${prefix}-${index}`,
    text: line.kind === "rule" ? markdownRuleText(width) : markdownRowText(line),
    style: line.kind === "code" || line.kind === "code-fence" ? "thinking" : line.kind === "rule" ? "border" : "assistant",
    indent: line.kind === "list" ? line.indent * 2 : undefined,
    bold: line.kind === "heading" || (line.kind === "table" && line.role === "header"),
    dim: line.kind === "code" || line.kind === "code-fence" || (line.kind === "table" && line.role === "rule"),
  }));
}

function plainPreviewLines(text: string, prefix: string): RenderLine[] {
  const source = text.split("\n");
  const visible = source.slice(0, 15).map((line, index) => ({ key: `${prefix}-${index}`, text: line, style: "muted" as const, dim: true }));
  const hidden = source.length - visible.length;
  if (hidden > 0) visible.push({ key: `${prefix}-more`, text: `… ${hidden} more ${hidden === 1 ? "line" : "lines"}`, style: "muted" as const, dim: true });
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
