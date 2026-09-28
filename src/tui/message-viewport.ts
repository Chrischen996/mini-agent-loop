import { resolveTranscriptMessage, type ChatMessage, type ThinkingDisplayMode } from "./state.ts";
import { countTerminalRows } from "./terminal-width.ts";
import { estimateThinkingRows } from "./thinking-lines.ts";
import { compactStreamingText, stripLeadingBlankLines } from "./text-utils.ts";
import { stripInlineMarkdown } from "./markdown-lines.ts";
import { countMarkdownRenderRows } from "./markdown-lines.ts";
import { isSubagentProtocolText, isSubagentToolName, subagentRenderLineCount } from "./subagent-lines.ts";

const TOOL_PREVIEW_LINES = 15;

type ClippedItem = { clipTop: number; clipTopActual: number; visibleHeight: number; actualHeight: number };
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

const EMPTY_EXPANDED: ReadonlySet<number> = Object.freeze(new Set<number>());

type HistoryBlock = { item: RawViewportItem; height: number; actual: number };

type PerMessageEntry = { width: number; thinkingMode: ThinkingDisplayMode; expanded: boolean; height: number; actual: number };

/** One cached walk of a specific messages array — the "window" layer. */
type DynamicChange = { id: string; index: number; revision: number; kind?: "subagent" | "tool" };

type ArrayBlocksEntry = {
  messages: ChatMessage[];
  width: number;
  thinkingMode: ThinkingDisplayMode;
  expandedKey: string;
  maxMessages: number;
  subagentById?: Readonly<Record<string, Extract<ChatMessage, { kind: "subagent_call" }>>>;
  toolById?: Readonly<Record<string, Extract<ChatMessage, { kind: "tool_call" }>>>;
  subagentRevision: number;
  toolRevision: number;
  blocks: HistoryBlock[];
  /** Prefix sums let the viewport locate the visible tail without walking N blocks. */
  prefixHeights: number[];
  totalHeight: number;
  totalActual: number;
};

type LiveBlocksKey = {
  streamingText: string;
  streamingReasoning: string;
  busy: boolean;
  thinkingMode: ThinkingDisplayMode;
  width: number;
};

type LiveBlocksEntry = {
  key: LiveBlocksKey;
  blocks: HistoryBlock[];
};

type LiveTextEntry = {
  text: string;
  busy: boolean;
  display: string;
};

type BlockCollection = {
  historyBlocks: HistoryBlock[];
  historyPrefixHeights: number[];
  liveBlocks: HistoryBlock[];
  totalHeight: number;
  totalActual: number;
};

// Keep a handful of recent arrays so session restore / rewind (which swap in
// a brand-new messages array) does not thrash the cache, but do not retain
// arrays forever.
const ARRAY_ENTRIES_CAP = 8;

/**
 * Two-layer row-count cache for completed history blocks.
 *
 * Layer 1 (per message, WeakMap): ordinary `ChatMessage` entries are
 * immutable once appended, so the object reference is a safe key. Dynamic
 * subagent cards are resolved from the normalized overlay before reaching
 * this layer; lifecycle updates replace that snapshot and the targeted window
 * entry is repaired separately. `width` / `thinkingMode` / `expanded` act as
 * validity guards: a resize, mode switch, or expand toggle recomputes exactly
 * the affected entries. WeakMap keeps superseded message objects from leaking
 * as the session grows.
 *
 * Layer 2 (per messages array): the history walk, prefix sums, and aggregate
 * heights are cached for the specific array reference. While streaming,
 * `state.messages` is unchanged, so the two App estimates are O(1), and the
 * MessageFeed selects its visible tail with a binary search plus only the
 * visible blocks. The walk re-runs when a new messages array appears (a
 * message was added or replaced), and even then each entry is a cheap
 * layer-1 lookup.
 */
export class MessageHeightCache {
  private entries = new WeakMap<ChatMessage, PerMessageEntry>();
  private arrayEntries: ArrayBlocksEntry[] = [];
  private liveEntry: LiveBlocksEntry | undefined;
  private liveTextEntry: LiveTextEntry | undefined;

  get(
    message: ChatMessage,
    index: number,
    options: { width: number; thinkingMode: ThinkingDisplayMode; expanded: boolean },
  ): { height: number; actual: number } {
    const { width, thinkingMode, expanded } = options;
    const hit = this.entries.get(message);
    if (hit && hit.width === width && hit.thinkingMode === thinkingMode && hit.expanded === expanded) {
      return { height: hit.height, actual: hit.actual };
    }
    const block = computeHistoryBlock(message, index, options);
    this.entries.set(message, { width, thinkingMode, expanded, height: block.height, actual: block.actual });
    return block;
  }

  /**
   * Cached history blocks and aggregate rows for one messages array. O(1) when
   * the same array reference is passed again with the same params (the
   * streaming-flush hot path); a single layer-1 walk otherwise.
   */
  getHistoryEntry(
    messages: ChatMessage[],
    options: { width: number; thinkingMode: ThinkingDisplayMode; expandedThinking: number[]; maxMessages: number; subagentById?: Readonly<Record<string, Extract<ChatMessage, { kind: "subagent_call" }>>>; toolById?: Readonly<Record<string, Extract<ChatMessage, { kind: "tool_call" }>>>; subagentRevision?: number; toolRevision?: number; subagentChange?: DynamicChange; toolChange?: DynamicChange; },
  ): ArrayBlocksEntry {
    const expandedKey = options.expandedThinking.join(",");
    const currentSubagentRevision = options.subagentRevision ?? options.subagentChange?.revision ?? 0;
    const currentToolRevision = options.toolRevision ?? options.toolChange?.revision ?? 0;
    for (const entry of this.arrayEntries) {
      if (
        entry.messages !== messages ||
        entry.width !== options.width ||
        entry.thinkingMode !== options.thinkingMode ||
        entry.expandedKey !== expandedKey ||
        entry.maxMessages !== options.maxMessages
      ) continue;
      if (
        entry.subagentById === options.subagentById &&
        entry.toolById === options.toolById &&
        entry.subagentRevision === currentSubagentRevision &&
        entry.toolRevision === currentToolRevision
      ) return entry;
      const change = entry.subagentRevision + 1 === currentSubagentRevision
        ? options.subagentChange
        : entry.toolRevision + 1 === currentToolRevision
          ? options.toolChange
          : undefined;
      const changeKind = change === options.toolChange ? "tool" : "subagent";
      const expectedRevision = changeKind === "tool" ? currentToolRevision : currentSubagentRevision;
      const startIndex = Math.max(0, messages.length - options.maxMessages);
      if (
        change &&
        change.revision === expectedRevision &&
        ((changeKind === "subagent" && entry.subagentRevision + 1 === change.revision && entry.toolRevision === currentToolRevision) ||
          (changeKind === "tool" && entry.toolRevision + 1 === change.revision && entry.subagentRevision === currentSubagentRevision)) &&
        change.index >= 0 &&
        change.index < messages.length
      ) {
        if (change.index < startIndex) {
          entry.subagentById = options.subagentById;
          entry.toolById = options.toolById;
          entry.subagentRevision = currentSubagentRevision;
          entry.toolRevision = currentToolRevision;
          return entry;
        }
        const localIndex = change.index - startIndex;
        const previous = entry.blocks[localIndex];
        const message = resolveTranscriptMessage(messages[change.index]!, options.subagentById ?? {}, options.toolById ?? {});
        const block = this.get(message, change.index, {
          width: options.width,
          thinkingMode: options.thinkingMode,
          expanded: options.expandedThinking.includes(change.index),
        });
        const next: HistoryBlock = { item: { kind: "message", index: change.index, message }, height: block.height, actual: block.actual };
        if (previous) {
          entry.blocks[localIndex] = next;
          const heightDelta = next.height - previous.height;
          const actualDelta = Math.min(next.height, next.actual) - Math.min(previous.height, previous.actual);
          entry.totalHeight += heightDelta;
          entry.totalActual += actualDelta;
          for (let index = localIndex; index < entry.prefixHeights.length; index++) {
            entry.prefixHeights[index] = (entry.prefixHeights[index] ?? 0) + heightDelta;
          }
        }
        entry.subagentById = options.subagentById;
        entry.toolById = options.toolById;
        entry.subagentRevision = currentSubagentRevision;
        entry.toolRevision = currentToolRevision;
        return entry;
      }
      break;
    }
    const startIndex = Math.max(0, messages.length - options.maxMessages);
    const expanded = new Set(options.expandedThinking);
    const blocks: HistoryBlock[] = [];
    for (let index = startIndex; index < messages.length; index++) {
      const message = resolveTranscriptMessage(messages[index]!, options.subagentById ?? {}, options.toolById ?? {});
      const block = this.get(message, index, { width: options.width, thinkingMode: options.thinkingMode, expanded: expanded.has(index) });
      blocks.push({ item: { kind: "message", index, message }, height: block.height, actual: block.actual });
    }
    const prefixHeights: number[] = [];
    let totalHeight = 0;
    let totalActual = 0;
    for (const block of blocks) {
      totalHeight += block.height;
      totalActual += Math.min(block.height, block.actual);
      prefixHeights.push(totalHeight);
    }
    this.arrayEntries.push({
      messages,
      width: options.width,
      thinkingMode: options.thinkingMode,
      expandedKey,
      maxMessages: options.maxMessages,
      subagentById: options.subagentById,
      toolById: options.toolById,
      subagentRevision: currentSubagentRevision,
      toolRevision: currentToolRevision,
      blocks,
      prefixHeights,
      totalHeight,
      totalActual,
    });
    if (this.arrayEntries.length > ARRAY_ENTRIES_CAP) this.arrayEntries.shift();
    return this.arrayEntries.at(-1)!;
  }

  getHistoryBlocks(
    messages: ChatMessage[],
    options: { width: number; thinkingMode: ThinkingDisplayMode; expandedThinking: number[]; maxMessages: number; subagentById?: Readonly<Record<string, Extract<ChatMessage, { kind: "subagent_call" }>>>; toolById?: Readonly<Record<string, Extract<ChatMessage, { kind: "tool_call" }>>>; subagentRevision?: number; toolRevision?: number; subagentChange?: DynamicChange; toolChange?: DynamicChange; },
  ): HistoryBlock[] {
    return this.getHistoryEntry(messages, options).blocks;
  }

  getStreamingDisplayText(text: string, busy: boolean): string {
    const previous = this.liveTextEntry;
    if (previous && previous.text === text && previous.busy === busy) return previous.display;
    const display = stripLeadingBlankLines(
      busy ? compactStreamingText(stripInlineMarkdown(text)) : stripInlineMarkdown(text),
    );
    this.liveTextEntry = { text, busy, display };
    return display;
  }

  getLiveBlocks(key: LiveBlocksKey, build: () => HistoryBlock[]): HistoryBlock[] {
    const previous = this.liveEntry?.key;
    if (
      previous &&
      previous.streamingText === key.streamingText &&
      previous.streamingReasoning === key.streamingReasoning &&
      previous.busy === key.busy &&
      previous.thinkingMode === key.thinkingMode &&
      previous.width === key.width
    ) return this.liveEntry!.blocks;
    const blocks = build();
    this.liveEntry = { key, blocks };
    return blocks;
  }

  clear(): void {
    this.entries = new WeakMap();
    this.arrayEntries = [];
    this.liveEntry = undefined;
    this.liveTextEntry = undefined;
  }
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
      // MessageFeed has paddingX={1} (−2 cols) and the user Box adds another
      // paddingX={1} (−2 cols), so the available wrap width is width − 4.
      // The "❯ " marker shares the same Text node and is included in the fold,
      // so we treat the full width−4 as the budget (first-line marker pushes
      // text by 2 cols, but continuation lines recover them; using width−4
      // keeps the estimate conservative and avoids under-counting).
      return 1 + Math.max(1, countTerminalRows(message.displayText ?? message.text, Math.max(10, width - 4))) + (message.images?.length ? 1 : 0);
    case "assistant":
      if (isSubagentProtocolText(message.text)) return 0;
      // Tool-only turns draw no rows: MessageFeed skips the block entirely
      // when an assistant message has neither reasoning nor text, so no
      // lone "⏺ " marker row is reserved.
      if (!message.reasoning && !message.text) return 0;
      // +1 for the marginTop={1} rendered above the assistant block in MessageFeed.
      return 1 + Math.max(
        1,
        thinkingRows(message.reasoning, thinkingMode, expandedThinking.has(index), width) +
          // Mirror countMarkdownRenderRows so scroll window and drawn rows use
          // the same row space (blank lines / inline syntax don't inflate).
          countMarkdownRenderRows(message.text, width),
      );
    case "notice":
      // +1 for the marginTop={1} row. Divider-style notice: optional title
      // row + one text row (no border box).
      // feed paddingX={1} (−2) + notice Box paddingX={1} (−2) = width − 4.
      return 1 + (message.title ? 1 : 0) + Math.max(1, countTerminalRows(message.text, Math.max(10, width - 4)));
    case "tool_call":
      if (isSubagentToolName(message.name)) return 0;
      // +1 for the marginTop={1} row, plus the title row and the nested
      // MessageResponse result (or Working... while the call is active).
      // Keep this estimate in lockstep with ToolCallRow.
      // ToolCallRow renders each \n-split line with wrap="truncate-end" (no
      // reflowing), so count newlines rather than terminal-width-wrapped rows.
      return 2 + (message.result
        ? Math.min(TOOL_PREVIEW_LINES + 1, message.result.split("\n").length)
        : message.status === "running" ? 1 : 0);
    case "subagent_call":
      // +1 for the marginTop={1} SubagentCard renders above the card rows.
      return 1 + subagentRenderLineCount(message, { width });
    case "error":
      // +1 for the marginTop={1} row.
      // feed paddingX={1} (−2) + "✗ " marker (−2) = width − 4 available.
      return 1 + Math.max(1, countTerminalRows(message.text, Math.max(10, width - 4)));
  }
}

function computeHistoryBlock(
  message: ChatMessage,
  index: number,
  options: { width: number; thinkingMode: ThinkingDisplayMode; expanded: boolean },
): { height: number; actual: number } {
  const { width, thinkingMode, expanded } = options;
  const expandedThinking = expanded ? new Set([index]) : EMPTY_EXPANDED;
  const height = estimateMessageHeight(message, { width, thinkingMode, expandedThinking, index });
  // Rows the Ink component actually draws. Markdown keeps one row per
  // source line for truncated kinds, so wrapping text can render fewer
  // rows than `countTerminalRows` estimates. The viewport clamps slice
  // boxes to the smaller number to avoid blank padding above the prompt.
  let actual = height;
  if (message.kind === "assistant" && !isSubagentProtocolText(message.text) && (message.reasoning || message.text)) {
    actual = 1 +
      estimateThinkingRows(message.reasoning, { mode: thinkingMode, forceExpanded: expanded, width }) +
      countMarkdownRenderRows(message.text, width);
  }
  return { height, actual };
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
  cache?: MessageHeightCache;
  subagentById?: Readonly<Record<string, Extract<ChatMessage, { kind: "subagent_call" }>>>;
  toolById?: Readonly<Record<string, Extract<ChatMessage, { kind: "tool_call" }>>>;
  subagentRevision?: number;
  toolRevision?: number;
  subagentChange?: DynamicChange;
  toolChange?: DynamicChange;
}): BlockCollection {
  const startIndex = Math.max(0, options.messages.length - options.maxMessages);
  const expanded = new Set(options.expandedThinking);
  let historyBlocks: HistoryBlock[];
  let historyPrefixHeights: number[];
  let historyTotalHeight = 0;
  let historyTotalActual = 0;
  if (options.cache) {
    const entry = options.cache.getHistoryEntry(options.messages, {
      width: options.width,
      thinkingMode: options.thinkingMode,
      expandedThinking: options.expandedThinking,
      maxMessages: options.maxMessages,
      subagentById: options.subagentById,
      toolById: options.toolById,
      subagentRevision: options.subagentRevision,
      toolRevision: options.toolRevision,
      subagentChange: options.subagentChange,
      toolChange: options.toolChange,
    });
    historyBlocks = entry.blocks;
    historyPrefixHeights = entry.prefixHeights;
    historyTotalHeight = entry.totalHeight;
    historyTotalActual = entry.totalActual;
  } else {
    historyBlocks = [];
    historyPrefixHeights = [];
    for (let index = startIndex; index < options.messages.length; index++) {
      const message = resolveTranscriptMessage(options.messages[index]!, options.subagentById ?? {}, options.toolById ?? {});
      const { height, actual } = computeHistoryBlock(message, index, { width: options.width, thinkingMode: options.thinkingMode, expanded: expanded.has(index) });
      historyBlocks.push({ item: { kind: "message", index, message }, height, actual });
      historyTotalHeight += height;
      historyTotalActual += Math.min(height, actual);
      historyPrefixHeights.push(historyTotalHeight);
    }
  }
  // Live stack (streaming_reasoning → streaming_text → busy_status) previews
  // the next history assistant. Cache it by immutable string references so the
  // App height estimates and MessageFeed selection share the same O(S) scan.
  const buildLiveBlocks = (): HistoryBlock[] => {
    const live: HistoryBlock[] = [];
    if (options.streamingReasoning) {
      const streamingThinkingRows = thinkingRows(options.streamingReasoning, options.thinkingMode, false, options.width, true);
      live.push({
        item: { kind: "streaming_reasoning" },
        height: 1 + streamingThinkingRows,
        actual: 1 + streamingThinkingRows,
      });
    }
    const textTopMargin = options.streamingReasoning ? 0 : 1;
    if (options.streamingText) {
      const displayText = options.cache
        ? options.cache.getStreamingDisplayText(options.streamingText, options.busy)
        : stripLeadingBlankLines(
          options.busy
            ? compactStreamingText(stripInlineMarkdown(options.streamingText))
            : stripInlineMarkdown(options.streamingText),
        );
      const rows = textTopMargin + Math.max(1, countTerminalRows(displayText, Math.max(10, options.width - 4)));
      live.push({ item: { kind: "streaming_text" }, height: rows, actual: rows });
    }
    const busyTopMargin = options.streamingReasoning || options.streamingText ? 0 : 1;
    if (options.busy) live.push({ item: { kind: "busy_status" }, height: 1 + busyTopMargin, actual: 1 + busyTopMargin });
    return live;
  };
  const liveBlocks = options.cache
    ? options.cache.getLiveBlocks({
      streamingText: options.streamingText,
      streamingReasoning: options.streamingReasoning,
      busy: options.busy,
      thinkingMode: options.thinkingMode,
      width: options.width,
    }, buildLiveBlocks)
    : buildLiveBlocks();
  const liveTotalHeight = liveBlocks.reduce((sum, block) => sum + block.height, 0);
  const liveTotalActual = liveBlocks.reduce((sum, block) => sum + Math.min(block.height, block.actual), 0);
  return {
    historyBlocks,
    historyPrefixHeights,
    liveBlocks,
    totalHeight: historyTotalHeight + liveTotalHeight,
    totalActual: historyTotalActual + liveTotalActual,
  };
}

export function estimateViewportContentHeight(options: Omit<Parameters<typeof selectMessageViewport>[0], "scrollOffset" | "availableHeight"> & { cache?: MessageHeightCache }): number {
  return buildBlocks({ ...options, maxMessages: options.maxMessages ?? Number.MAX_SAFE_INTEGER }).totalHeight;
}

/**
 * Sum of the rows Ink will actually draw for the same content selection.
 * Used to size the TUI frame so over-estimated transcript height does not
 * pin the frame at full terminal height and leave a blank band above the
 * prompt. Never exceeds `estimateViewportContentHeight` for the same input.
 */
export function estimateViewportActualHeight(options: Omit<Parameters<typeof selectMessageViewport>[0], "scrollOffset" | "availableHeight"> & { cache?: MessageHeightCache }): number {
  return buildBlocks({ ...options, maxMessages: options.maxMessages ?? Number.MAX_SAFE_INTEGER }).totalActual;
}

function upperBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (values[middle]! <= target) low = middle + 1;
    else high = middle;
  }
  return low;
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
  /** Optional per-message height cache for completed history blocks. */
  cache?: MessageHeightCache;
  subagentById?: Readonly<Record<string, Extract<ChatMessage, { kind: "subagent_call" }>>>;
  toolById?: Readonly<Record<string, Extract<ChatMessage, { kind: "tool_call" }>>>;
  subagentRevision?: number;
  toolRevision?: number;
  subagentChange?: DynamicChange;
  toolChange?: DynamicChange;
}): ViewportSelection {
  const heightBudget = Math.max(3, options.availableHeight);
  const showHistoryHints = options.showHistoryHints ?? true;
  const collection = buildBlocks({ ...options, maxMessages: options.maxMessages ?? Number.MAX_SAFE_INTEGER });
  const totalHeight = collection.totalHeight;
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

  const appendVisibleBlock = (block: HistoryBlock, blockStart: number): void => {
    const blockEnd = blockStart + block.height;
    // The block's own rows Ink will actually draw. `block.height` is the
    // wrap-aware estimate used for scroll accounting; `clippedActual` is the
    // real row budget so the rendered slice never exceeds it.
    const clippedActual = Math.min(block.actual, block.height);
    const visibleStart = Math.max(blockStart, startRow);
    const visibleEnd = Math.min(blockEnd, endRow);
    if (visibleStart >= visibleEnd) return;
    const clipTop = Math.min(
      Math.max(0, visibleStart - blockStart),
      Math.max(0, clippedActual - 1),
    );
    const clipTopActual = Math.max(0, Math.min(
      Math.round(clipTop * clippedActual / Math.max(1, block.height)),
      clippedActual - 1,
    ));
    items.push({
      ...block.item,
      clipTop,
      clipTopActual,
      visibleHeight: visibleEnd - visibleStart,
      actualHeight: clippedActual,
    } as ViewportItem);
  };

  // History blocks are indexed by prefix sums. Locate the visible tail with
  // binary search, then visit only the blocks that can contribute rows.
  const historyPrefix = collection.historyPrefixHeights;
  const firstHistory = upperBound(historyPrefix, startRow);
  const endHistory = endRow <= 0
    ? 0
    : Math.min(historyPrefix.length, upperBound(historyPrefix, endRow - 1) + 1);
  for (let index = firstHistory; index < endHistory; index++) {
    const blockStart = index === 0 ? 0 : historyPrefix[index - 1]!;
    appendVisibleBlock(collection.historyBlocks[index]!, blockStart);
  }

  let liveStart = historyPrefix.at(-1) ?? 0;
  for (const block of collection.liveBlocks) {
    appendVisibleBlock(block, liveStart);
    liveStart += block.height;
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
