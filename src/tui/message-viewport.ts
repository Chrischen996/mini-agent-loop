import type { ChatMessage, ThinkingDisplayMode } from "./state.ts";
import { countTerminalRows } from "./terminal-width.ts";
import { estimateThinkingRows } from "./thinking-lines.ts";
import { compactStreamingText } from "./text-utils.ts";
import { isSubagentProtocolText, isSubagentToolName, subagentRenderLineCount } from "./subagent-lines.ts";

const TOOL_PREVIEW_LINES = 15;

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
  return estimateThinkingRows(content, { mode, forceExpanded, width });
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
      return Math.max(1, countTerminalRows(message.displayText ?? message.text, Math.max(10, width - 4))) + (message.images?.length ? 1 : 0);
    case "assistant":
      if (isSubagentProtocolText(message.text)) return 0;
      return Math.max(
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
      return 1 + (message.result
        ? Math.min(TOOL_PREVIEW_LINES + 1, countTerminalRows(message.result, Math.max(10, width - 4)))
        : message.status === "running" ? 1 : 0);
    case "subagent_call":
      return subagentRenderLineCount(message, { width });
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
      height: Math.max(1, countTerminalRows(options.busy ? compactStreamingText(options.streamingText) : options.streamingText, Math.max(10, options.width - 2))),
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
