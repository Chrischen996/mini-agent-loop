import type { ChatMessage, ThinkingDisplayMode } from "./state.ts";
import { countTerminalRows } from "./terminal-width.ts";
import { estimateThinkingRows } from "./thinking-lines.ts";
import { compactStreamingText } from "./text-utils.ts";
import { stripInlineMarkdown } from "./markdown-lines.ts";
import { countMarkdownRenderRows } from "./markdown-lines.ts";
import { isSubagentProtocolText, isSubagentToolName, subagentRenderLineCount } from "./subagent-lines.ts";

const TOOL_PREVIEW_LINES = 15;

type ClippedItem = { clipTop: number; visibleHeight: number; actualHeight: number };
type RawViewportItem =
  | { kind: "message"; index: number; message: ChatMessage }
  | { kind: "streaming_reasoning" }
  | { kind: "streaming_text" }
  | { kind: "busy_status" };

export type ViewportItem =
  | { kind: "history_hint"; direction: "above" | "below"; hiddenRows: number }
  | ({ kind: "message"; index: number; message: ChatMessage } & ClippedItem)
  | ({ kind: "streaming_reasoning" } & ClippedItem)
  | ({ kind: "streaming_text" } & ClippedItem)
  | ({ kind: "busy_status" } & ClippedItem);

export type ViewportSelection = {
  items: ViewportItem[];
  hiddenAbove: number;
  hiddenBelow: number;
  pinnedToBottom: boolean;
  maxScrollOffset: number;
  totalHeight: number;
};

function thinkingRows(
  content: string | undefined,
  mode: ThinkingDisplayMode,
  forceExpanded: boolean,
  width: number,
  isStreaming = false,
): number {
  return estimateThinkingRows(content, { mode, forceExpanded, width, isStreaming });
}

export function estimateMessageHeight(
  message: ChatMessage,
  options: {
    width: number;
    thinkingMode: ThinkingDisplayMode;
    expandedThinking: ReadonlySet<number>;
    index: number;
  },
): number {
  const { width, thinkingMode, expandedThinking, index } = options;
  switch (message.kind) {
    case "user":
      // +1 for the marginTop={1} rendered above the user bubble in MessageFeed.
      // The terminal renderer prefixes user messages with "❯ " (2 cols), so
      // the available wrap width is width - 2, not width - 4.
      return 1 + Math.max(1, countTerminalRows(message.displayText ?? message.text, Math.max(10, width - 2))) + (message.images?.length ? 1 : 0);
    case "assistant":
      if (isSubagentProtocolText(message.text)) return 0;
      // +1 for the marginTop={1} rendered above the assistant block in MessageFeed.
      return 1 + Math.max(
        1,
        thinkingRows(message.reasoning, thinkingMode, expandedThinking.has(index), width) +
          countTerminalRows(message.text, Math.max(10, width - 2)),
      );
    case "notice":
      // Divider-style notice: optional title row + one text row (no border box).
      return (message.title ? 1 : 0) + Math.max(1, countTerminalRows(message.text, Math.max(10, width - 2)));
    case "tool_call":
      if (isSubagentToolName(message.name)) return 0;
      // Ink's Claude-style tool row is no longer a bordered card: one title
      // row plus the nested MessageResponse result (or Running... while the
      // call is active). Keep this estimate in lockstep with ToolCallRow.
      // ToolCallRow renders each \n-split line with wrap="truncate-end" (no
      // reflowing), so count newlines rather than terminal-width-wrapped rows.
      return 1 + (message.result
        ? Math.min(TOOL_PREVIEW_LINES + 1, message.result.split("\n").length)
        : message.status === "running" ? 1 : 0);
    case "subagent_call":
      // +1 for the marginTop={1} SubagentCard renders above the card rows.
      return 1 + subagentRenderLineCount(message, { width });
    case "error":
      return Math.max(1, countTerminalRows(message.text, Math.max(10, width - 2)));
  }
}

function buildBlocks(options: {
  messages: ChatMessage[];
  streamingText: string;
  streamingReasoning: string;
  busy: boolean;
  thinkingMode: ThinkingDisplayMode;
  expandedThinking: number[];
  width: number;
  maxMessages: number;
}): Array<{ item: RawViewportItem; height: number; actual: number }> {
  const startIndex = Math.max(0, options.messages.length - options.maxMessages);
  const expanded = new Set(options.expandedThinking);
  const blocks: Array<{ item: RawViewportItem; height: number; actual: number }> = [];
  for (let index = startIndex; index < options.messages.length; index++) {
    const message = options.messages[index]!;
    const estimated = estimateMessageHeight(message, {
      width: options.width,
      thinkingMode: options.thinkingMode,
      expandedThinking: expanded,
      index,
    });
    // Rows the Ink component actually draws. Markdown keeps one row per
    // source line for truncated kinds, so wrapping text can render fewer
    // rows than `countTerminalRows` estimates. The viewport clamps slice
    // boxes to the smaller number to avoid blank padding above the prompt.
    let actual = estimated;
    if (message.kind === "assistant" && !isSubagentProtocolText(message.text)) {
      actual = 1 +
        estimateThinkingRows(message.reasoning, {
          mode: options.thinkingMode,
          forceExpanded: expanded.has(index),
          width: options.width,
        }) +
        countMarkdownRenderRows(message.text, options.width);
    }
    blocks.push({ item: { kind: "message", index, message }, height: estimated, actual });
  }
  if (options.streamingReasoning) {
    // MessageFeed renders the live block as <ThinkingBlock isStreaming={busy} />
    // with no forceExpanded, so both height and actual must estimate it as
    // streaming: in summary mode that collapses to 1 hint row even at ≤3 lines,
    // matching thinkingVisibleLines' render decision. Without isStreaming the
    // estimate wrongly expanded short blocks and over-sized the frame.
    const streamingThinkingRows = thinkingRows(options.streamingReasoning, options.thinkingMode, false, options.width, true);
    blocks.push({
      item: { kind: "streaming_reasoning" },
      height: streamingThinkingRows,
      actual: streamingThinkingRows,
    });
  }
  if (options.streamingText) {
    const displayText = options.busy
      ? compactStreamingText(stripInlineMarkdown(options.streamingText))
      : stripInlineMarkdown(options.streamingText);
    blocks.push({
      item: { kind: "streaming_text" },
      height: Math.max(1, countTerminalRows(options.busy ? compactStreamingText(options.streamingText) : options.streamingText, Math.max(10, options.width - 2))),
      actual: Math.max(1, countTerminalRows(displayText, Math.max(10, options.width - 4))),
    });
  }
  if (options.busy) blocks.push({ item: { kind: "busy_status" }, height: 1, actual: 1 });
  return blocks;
}

export function estimateViewportContentHeight(options: Omit<Parameters<typeof selectMessageViewport>[0], "scrollOffset" | "availableHeight">): number {
  return buildBlocks({ ...options, maxMessages: options.maxMessages ?? 200 }).reduce((sum, block) => sum + block.height, 0);
}

/**
 * Sum of the rows Ink will actually draw for the same content selection.
 * Used to size the TUI frame so over-estimated transcript height does not
 * pin the frame at full terminal height and leave a blank band above the
 * prompt. Never exceeds `estimateViewportContentHeight` for the same input.
 */
export function estimateViewportActualHeight(options: Omit<Parameters<typeof selectMessageViewport>[0], "scrollOffset" | "availableHeight">): number {
  return buildBlocks({ ...options, maxMessages: options.maxMessages ?? 200 }).reduce((sum, block) => sum + Math.min(block.height, block.actual), 0);
}

/** Build a bottom-anchored, row-addressable viewport. */
export function selectMessageViewport(options: {
  messages: ChatMessage[];
  streamingText: string;
  streamingReasoning: string;
  busy: boolean;
  thinkingMode: ThinkingDisplayMode;
  expandedThinking: number[];
  scrollOffset: number;
  availableHeight: number;
  width: number;
  maxMessages?: number;
  /** Renderers may hide the hint row while retaining scroll accounting. */
  showHistoryHints?: boolean;
}): ViewportSelection {
  const heightBudget = Math.max(3, options.availableHeight);
  const showHistoryHints = options.showHistoryHints ?? true;
  const blocks = buildBlocks({ ...options, maxMessages: options.maxMessages ?? 200 });
  const totalHeight = blocks.reduce((sum, block) => sum + block.height, 0);
  const maxScrollOffset = Math.max(0, totalHeight - Math.max(1, heightBudget - 1));
  const scrollOffset = Math.max(0, Math.min(options.scrollOffset, maxScrollOffset));

  let dataHeight = heightBudget;
  let startRow = 0;
  let endRow = totalHeight;
  for (let pass = 0; pass < 3; pass++) {
    endRow = Math.max(0, totalHeight - scrollOffset);
    startRow = Math.max(0, endRow - dataHeight);
    const hints = showHistoryHints
      ? (startRow > 0 ? 1 : 0) + (endRow < totalHeight ? 1 : 0)
      : 0;
    dataHeight = Math.max(1, heightBudget - hints);
  }

  const items: ViewportItem[] = [];
  if (showHistoryHints && startRow > 0) items.push({ kind: "history_hint", direction: "above", hiddenRows: startRow });

  let blockStart = 0;
  for (const block of blocks) {
    const blockEnd = blockStart + block.height;
    const visibleStart = Math.max(blockStart, startRow);
    const visibleEnd = Math.min(blockEnd, endRow);
    if (visibleStart < visibleEnd) {
      items.push({
        ...block.item,
        clipTop: visibleStart - blockStart,
        visibleHeight: visibleEnd - visibleStart,
        actualHeight: Math.min(block.actual, block.height),
      } as ViewportItem);
    }
    blockStart = blockEnd;
  }

  if (showHistoryHints && endRow < totalHeight) items.push({ kind: "history_hint", direction: "below", hiddenRows: totalHeight - endRow });
  return {
    items,
    hiddenAbove: startRow,
    hiddenBelow: totalHeight - endRow,
    pinnedToBottom: scrollOffset === 0,
    maxScrollOffset,
    totalHeight,
  };
}

export function clampScrollOffset(scrollOffset: number, maxScrollOffset: number): number {
  return Math.max(0, Math.min(scrollOffset, Math.max(0, maxScrollOffset)));
}
