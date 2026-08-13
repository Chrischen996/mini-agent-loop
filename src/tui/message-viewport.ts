import type { ChatMessage, ThinkingDisplayMode } from "./state.ts";
import { countTerminalRows } from "./terminal-width.ts";

const THINKING_SUMMARY_LINES = 3;
const THINKING_MAX_FULL_LINES = 30;
const TOOL_PREVIEW_LINES = 10;
const SUBAGENT_COLLAPSED_LINES = 3;
const SUBAGENT_EXPANDED_INNER = 8;

type ClippedItem = { clipTop: number; visibleHeight: number };
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
): number {
  if (!content || (mode === "hidden" && !forceExpanded)) return 0;
  const sourceLines = content.split("\n").length;
  const showFull = forceExpanded || mode === "full" || (mode === "summary" && sourceLines <= THINKING_SUMMARY_LINES);
  const maxLines = showFull ? THINKING_MAX_FULL_LINES : THINKING_SUMMARY_LINES;
  const visible = content.split("\n").slice(0, maxLines).join("\n");
  const bodyRows = countTerminalRows(visible, Math.max(10, width - 4));
  const truncationRow = sourceLines > maxLines ? 1 : 0;
  return 3 + bodyRows + truncationRow;
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
      return Math.max(1, countTerminalRows(message.text, Math.max(10, width - 4))) + (message.images?.length ? 1 : 0);
    case "assistant":
      return Math.max(
        1,
        thinkingRows(message.reasoning, thinkingMode, expandedThinking.has(index), width) +
          countTerminalRows(message.text, Math.max(10, width - 2)),
      );
    case "notice":
      return 2 + (message.title ? 1 : 0) + Math.max(1, countTerminalRows(message.text, Math.max(10, width - 4)));
    case "tool_call":
      return 1 + (message.result
        ? Math.min(TOOL_PREVIEW_LINES, countTerminalRows(message.result, Math.max(10, width - 4)))
        : 0);
    case "subagent_call":
      return message.expanded
        ? SUBAGENT_COLLAPSED_LINES + Math.min(SUBAGENT_EXPANDED_INNER, message.innerEvents.length)
        : SUBAGENT_COLLAPSED_LINES;
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
}): Array<{ item: RawViewportItem; height: number }> {
  const startIndex = Math.max(0, options.messages.length - options.maxMessages);
  const expanded = new Set(options.expandedThinking);
  const blocks: Array<{ item: RawViewportItem; height: number }> = [];
  for (let index = startIndex; index < options.messages.length; index++) {
    const message = options.messages[index]!;
    blocks.push({
      item: { kind: "message", index, message },
      height: estimateMessageHeight(message, {
        width: options.width,
        thinkingMode: options.thinkingMode,
        expandedThinking: expanded,
        index,
      }),
    });
  }
  if (options.streamingReasoning) {
    blocks.push({
      item: { kind: "streaming_reasoning" },
      height: thinkingRows(options.streamingReasoning, options.thinkingMode, false, options.width),
    });
  }
  if (options.streamingText) {
    blocks.push({
      item: { kind: "streaming_text" },
      height: Math.max(1, countTerminalRows(options.streamingText, Math.max(10, options.width - 2))),
    });
  }
  if (options.busy) blocks.push({ item: { kind: "busy_status" }, height: 1 });
  return blocks;
}

export function estimateViewportContentHeight(options: Omit<Parameters<typeof selectMessageViewport>[0], "scrollOffset" | "availableHeight">): number {
  return buildBlocks({ ...options, maxMessages: options.maxMessages ?? 200 }).reduce((sum, block) => sum + block.height, 0);
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
}): ViewportSelection {
  const heightBudget = Math.max(3, options.availableHeight);
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
    const hints = (startRow > 0 ? 1 : 0) + (endRow < totalHeight ? 1 : 0);
    dataHeight = Math.max(1, heightBudget - hints);
  }

  const items: ViewportItem[] = [];
  if (startRow > 0) items.push({ kind: "history_hint", direction: "above", hiddenRows: startRow });

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
      } as ViewportItem);
    }
    blockStart = blockEnd;
  }

  if (endRow < totalHeight) items.push({ kind: "history_hint", direction: "below", hiddenRows: totalHeight - endRow });
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
