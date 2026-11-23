import { resolveTranscriptMessage, type ChatMessage, type ThinkingDisplayMode } from "./state.ts";
import { messagePhysicalRows, projectAssistantBodyRows, streamingGapRow, streamingPhysicalRows, type PhysicalRow } from "./message-rows.ts";
import { assistantSealRemainingRows, computeCommitBoundary } from "./stream-commit.ts";

type RawViewportItem =
  | { kind: "message"; index: number; message: ChatMessage }
  | { kind: "streaming_reasoning" }
  | { kind: "streaming_text" }
  | { kind: "busy_status" };

export type ViewportItem =
  | { kind: "history_hint"; direction: "above" | "below"; hiddenRows: number }
  | ({ kind: "message"; index: number; message: ChatMessage } & ViewportSliceInfo)
  | ({ kind: "streaming_reasoning" } & ViewportSliceInfo)
  | ({ kind: "streaming_text" } & ViewportSliceInfo)
  | ({ kind: "busy_status" } & ViewportSliceInfo);

export type ViewportSelection = {
  items: ViewportItem[];
  hiddenAbove: number;
  hiddenBelow: number;
  pinnedToBottom: boolean;
  maxScrollOffset: number;
  totalHeight: number;
};

/** Physical-row slice handed to the feed for one viewport block. */
export type ViewportSliceInfo = {
  clipTop: number;
  visibleHeight: number;
  rows: PhysicalRow[];
};

type HistoryBlock = { item: RawViewportItem; height: number; rows: PhysicalRow[] };

type PerMessageEntry = { width: number; thinkingMode: ThinkingDisplayMode; expanded: boolean; rows: PhysicalRow[] };

/** One cached walk of a specific messages array — the "window" layer. */
type DynamicChange = { id: string; index: number; revision: number; kind?: "subagent" | "tool" };

type ArrayBlocksEntry = {
  messages: ChatMessage[];
  width: number;
  thinkingMode: ThinkingDisplayMode;
  expandedKey: string;
  maxMessages: number;
  /** First transcript index owned by the dynamic frame (sealed prefix excluded). */
  historyStartIndex: number;
  subagentById?: Readonly<Record<string, Extract<ChatMessage, { kind: "subagent_call" }>>>;
  toolById?: Readonly<Record<string, Extract<ChatMessage, { kind: "tool_call" }>>>;
  subagentRevision: number;
  toolRevision: number;
  blocks: HistoryBlock[];
  /** Prefix sums let the viewport locate the visible tail without walking N blocks. */
  prefixHeights: number[];
  totalHeight: number;
};

type LiveBlocksKey = {
  streamingText: string;
  streamingReasoning: string;
  busy: boolean;
  thinkingMode: ThinkingDisplayMode;
  width: number;
  documentMode: boolean;
  committedStreamingRows: number;
  sealedAssistantRows?: readonly PhysicalRow[];
  committedAssistantTexts?: readonly string[];
};

type LiveBlocksEntry = {
  key: LiveBlocksKey;
  blocks: HistoryBlock[];
};

// Keep a handful of recent arrays so session restore / rewind (which swap in
// a brand-new messages array) does not thrash the cache, but do not retain
// arrays forever.
const ARRAY_ENTRIES_CAP = 8;

/**
 * Two-layer physical-row cache for completed history blocks.
 *
 * Layer 1 (per message, WeakMap): ordinary `ChatMessage` entries are
 * immutable once appended, so the object reference is a safe key. The cached
 * value is the projected `PhysicalRow[]` itself — scroll accounting and the
 * rendered frame consume the exact same rows, so estimates can no longer
 * drift from what the terminal shows (the root cause of clipped-row
 * misalignment for CJK/emoji/long markdown). `width` / `thinkingMode` /
 * `expanded` act as validity guards: a resize, mode switch, or expand toggle
 * recomputes exactly the affected entries. WeakMap keeps superseded message
 * objects from leaking as the session grows.
 *
 * Layer 2 (per messages array): the history walk and prefix sums are cached
 * for the specific array reference, with the same targeted single-block
 * repair for dynamic subagent/tool overlays as before. While streaming,
 * `state.messages` is unchanged, so the App estimates stay O(1).
 */
// Key prefix shared by every streaming projection: `messagePhysicalRows`
// for index -1 keys rows as `message--1-...`.
const STREAMING_KEY_PREFIX = "message--1";

/**
 * Incremental projection of streaming assistant text. The settled prefix
 * (per `computeCommitBoundary`) is projected once and cached; later calls
 * project only the newly settled lines plus the growing tail. The entry
 * is dropped when the text stops extending the cached prefix (new stream
 * generation or the bounded-preview reset), which costs one full
 * re-projection.
 */
type StreamingProjectionEntry = {
  width: number;
  thinkingMode: ThinkingDisplayMode;
  /** Settled prefix; always ends at a commit boundary (a line end). */
  text: string;
  /** Rows for the settled prefix, including the leading gap row. */
  rows: PhysicalRow[];
  fence: { open: boolean; lang: string };
  /** Source lines inside `text`; drives `lineIndexOffset` of the tail. */
  lineCount: number;
};

/** Source lines in a settled fragment (char scan — no string allocation). */
function countSettledLines(settled: string): number {
  if (!settled) return 0;
  let count = 0;
  for (let i = 0; i < settled.length; i += 1) if (settled.charCodeAt(i) === 10) count += 1;
  return count;
}

export class MessageHeightCache {
  private entries = new WeakMap<ChatMessage, PerMessageEntry>();
  private arrayEntries: ArrayBlocksEntry[] = [];
  private liveEntry: LiveBlocksEntry | undefined;
  private sealedEntry:
    | {
      messages: ChatMessage[];
      width: number;
      thinkingMode: ThinkingDisplayMode;
      expandedKey: string;
      subagentById?: Readonly<Record<string, Extract<ChatMessage, { kind: "subagent_call" }>>>;
      toolById?: Readonly<Record<string, Extract<ChatMessage, { kind: "tool_call" }>>>;
      subagentRevision: number;
      toolRevision: number;
      sealedSubagentCards: boolean;
      sealedCount: number;
      items: SealedStaticItem[];
    }
    | undefined;
  private streamingEntry: StreamingProjectionEntry | undefined;

  get(
    message: ChatMessage,
    index: number,
    options: { width: number; thinkingMode: ThinkingDisplayMode; expanded: boolean },
  ): { height: number; rows: PhysicalRow[] } {
    const { width, thinkingMode, expanded } = options;
    const hit = this.entries.get(message);
    if (hit && hit.width === width && hit.thinkingMode === thinkingMode && hit.expanded === expanded) {
      return { height: hit.rows.length, rows: hit.rows };
    }
    const rows = messagePhysicalRows(message, index, { width, thinkingMode, expanded, focused: false });
    this.entries.set(message, { width, thinkingMode, expanded, rows });
    return { height: rows.length, rows };
  }

  /**
   * Cached history blocks and aggregate rows for one messages array. O(1) when
   * the same array reference is passed again with the same params (the
   * streaming-flush hot path); a single layer-1 walk otherwise.
   */
  getHistoryEntry(
    messages: ChatMessage[],
    options: { width: number; thinkingMode: ThinkingDisplayMode; expandedThinking: number[]; maxMessages: number; historyStartIndex?: number; subagentById?: Readonly<Record<string, Extract<ChatMessage, { kind: "subagent_call" }>>>; toolById?: Readonly<Record<string, Extract<ChatMessage, { kind: "tool_call" }>>>; subagentRevision?: number; toolRevision?: number; subagentChange?: DynamicChange; toolChange?: DynamicChange },
  ): ArrayBlocksEntry {
    const expandedKey = options.expandedThinking.join(",");
    const historyStartIndex = Math.max(0, options.historyStartIndex ?? 0);
    const currentSubagentRevision = options.subagentRevision ?? options.subagentChange?.revision ?? 0;
    const currentToolRevision = options.toolRevision ?? options.toolChange?.revision ?? 0;
    for (const entry of this.arrayEntries) {
      if (
        entry.messages !== messages ||
        entry.width !== options.width ||
        entry.thinkingMode !== options.thinkingMode ||
        entry.expandedKey !== expandedKey ||
        entry.maxMessages !== options.maxMessages ||
        entry.historyStartIndex !== historyStartIndex
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
      const blockStart = Math.max(0, messages.length - options.maxMessages, historyStartIndex);
      if (
        change &&
        change.revision === expectedRevision &&
        ((changeKind === "subagent" && entry.subagentRevision + 1 === change.revision && entry.toolRevision === currentToolRevision) ||
          (changeKind === "tool" && entry.toolRevision + 1 === change.revision && entry.subagentRevision === currentSubagentRevision)) &&
        change.index >= blockStart &&
        change.index < messages.length
      ) {
        const localIndex = change.index - blockStart;
        const previous = entry.blocks[localIndex];
        const message = resolveTranscriptMessage(messages[change.index]!, options.subagentById ?? {}, options.toolById ?? {});
        const block = this.get(message, change.index, {
          width: options.width,
          thinkingMode: options.thinkingMode,
          expanded: options.expandedThinking.includes(change.index),
        });
        const next: HistoryBlock = { item: { kind: "message", index: change.index, message }, height: block.height, rows: block.rows };
        if (previous) {
          entry.blocks[localIndex] = next;
          const heightDelta = next.height - previous.height;
          entry.totalHeight += heightDelta;
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
    const blockStart = Math.max(0, messages.length - options.maxMessages, historyStartIndex);
    const expanded = new Set(options.expandedThinking);
    const blocks: HistoryBlock[] = [];
    for (let index = blockStart; index < messages.length; index++) {
      const message = resolveTranscriptMessage(messages[index]!, options.subagentById ?? {}, options.toolById ?? {});
      const block = this.get(message, index, { width: options.width, thinkingMode: options.thinkingMode, expanded: expanded.has(index) });
      blocks.push({ item: { kind: "message", index, message }, height: block.height, rows: block.rows });
    }
    const prefixHeights: number[] = [];
    let totalHeight = 0;
    for (const block of blocks) {
      totalHeight += block.height;
      prefixHeights.push(totalHeight);
    }
    this.arrayEntries.push({
      messages,
      width: options.width,
      thinkingMode: options.thinkingMode,
      expandedKey,
      maxMessages: options.maxMessages,
      historyStartIndex,
      subagentById: options.subagentById,
      toolById: options.toolById,
      subagentRevision: currentSubagentRevision,
      toolRevision: currentToolRevision,
      blocks,
      prefixHeights,
      totalHeight,
    });
    if (this.arrayEntries.length > ARRAY_ENTRIES_CAP) this.arrayEntries.shift();
    return this.arrayEntries.at(-1)!;
  }

  getLiveBlocks(key: LiveBlocksKey, build: () => HistoryBlock[]): HistoryBlock[] {
    const previous = this.liveEntry?.key;
    if (
      previous &&
      previous.streamingText === key.streamingText &&
      previous.streamingReasoning === key.streamingReasoning &&
      previous.busy === key.busy &&
      previous.thinkingMode === key.thinkingMode &&
      previous.width === key.width &&
      previous.documentMode === key.documentMode &&
      previous.committedStreamingRows === key.committedStreamingRows &&
      previous.sealedAssistantRows === key.sealedAssistantRows &&
      previous.committedAssistantTexts === key.committedAssistantTexts
    ) return this.liveEntry!.blocks;
    const blocks = build();
    this.liveEntry = { key, blocks };
    return blocks;
  }

  /**
   * Cached `<Static>` payload for the sealed transcript prefix. The `items`
   * array identity is stable until the seal boundary, width, thinking mode,
   * thinking expansion, or overlay state changes, so re-renders never re-emit
   * already-scrolled static output; growth emits exactly the newly sealed tail.
   */
  getSealedStaticEntry(
    messages: ChatMessage[],
    options: {
      width: number;
      thinkingMode: ThinkingDisplayMode;
      expandedThinking: number[];
      subagentById?: Readonly<Record<string, Extract<ChatMessage, { kind: "subagent_call" }>>>;
      toolById?: Readonly<Record<string, Extract<ChatMessage, { kind: "tool_call" }>>>;
      subagentRevision?: number;
      toolRevision?: number;
      sealedSubagentCards?: boolean;
    },
  ): { sealedCount: number; items: SealedStaticItem[] } {
    const expandedKey = options.expandedThinking.join(",");
    const subagentRevision = options.subagentRevision ?? 0;
    const toolRevision = options.toolRevision ?? 0;
    const sealedSubagentCards = options.sealedSubagentCards === true;
    const entry = this.sealedEntry;
    if (
      entry &&
      entry.messages === messages &&
      entry.width === options.width &&
      entry.thinkingMode === options.thinkingMode &&
      entry.expandedKey === expandedKey &&
      entry.subagentById === options.subagentById &&
      entry.toolById === options.toolById &&
      entry.subagentRevision === subagentRevision &&
      entry.toolRevision === toolRevision &&
      entry.sealedSubagentCards === sealedSubagentCards
    ) {
      return { sealedCount: entry.sealedCount, items: entry.items };
    }
    const result = computeSealedStaticItems(messages, options, this);
    this.sealedEntry = {
      messages,
      width: options.width,
      thinkingMode: options.thinkingMode,
      expandedKey,
      subagentById: options.subagentById,
      toolById: options.toolById,
      subagentRevision,
      toolRevision,
      sealedSubagentCards,
      sealedCount: result.sealedCount,
      items: result.items,
    };
    return result;
  }

  /**
   * Incremental streaming projection (document layout hot path).
   *
   * Re-projects only the lines that settled since the last call plus the
   * growing tail; the settled prefix rows are cached. Cold start, width /
   * thinking-mode changes, and new stream generations (text no longer
   * extends the cached prefix) fall back to one full projection.
   */
  getStreamingAssistantRows(text: string, options: { width: number; thinkingMode: ThinkingDisplayMode }): PhysicalRow[] {
    if (!text) return [];
    const { width, thinkingMode } = options;
    const entry = this.streamingEntry;
    if (entry && entry.width === width && entry.thinkingMode === thinkingMode && text.startsWith(entry.text)) {
      const settledEnd = computeCommitBoundary(text);
      if (settledEnd >= entry.text.length) {
        let settledRows = entry.rows;
        let fence = entry.fence;
        let settledText = entry.text;
        let lineCount = entry.lineCount;
        if (settledEnd > settledText.length) {
          const newlySettled = text.slice(settledText.length, settledEnd);
          const projected = projectAssistantBodyRows(newlySettled, {
            keyPrefix: STREAMING_KEY_PREFIX,
            width,
            initialFence: fence,
            lineIndexOffset: lineCount,
          });
          settledRows = [...settledRows, ...projected.rows];
          fence = projected.fence;
          settledText = text.slice(0, settledEnd);
          lineCount += countSettledLines(newlySettled);
        }
        this.streamingEntry = { width, thinkingMode, text: settledText, rows: settledRows, fence, lineCount };
        const tail = text.slice(settledEnd);
        if (!tail) return settledRows;
        const tailRows = projectAssistantBodyRows(tail, {
          keyPrefix: STREAMING_KEY_PREFIX,
          width,
          initialFence: fence,
          lineIndexOffset: lineCount,
        }).rows;
        return [...settledRows, ...tailRows];
      }
    }
    // Cold start or invalidated prefix: one full projection, cache the settled part.
    const boundary = computeCommitBoundary(text);
    const prefixText = text.slice(0, boundary);
    const projected = projectAssistantBodyRows(prefixText, { keyPrefix: STREAMING_KEY_PREFIX, width });
    const prefixRows = [streamingGapRow(), ...projected.rows];
    const prefixLineCount = countSettledLines(prefixText);
    this.streamingEntry = {
      width,
      thinkingMode,
      text: prefixText,
      rows: prefixRows,
      fence: projected.fence,
      lineCount: prefixLineCount,
    };
    const tailText = text.slice(boundary);
    if (!tailText) return prefixRows;
    const tailRows = projectAssistantBodyRows(tailText, {
      keyPrefix: STREAMING_KEY_PREFIX,
      width,
      initialFence: projected.fence,
      lineIndexOffset: prefixLineCount,
    }).rows;
    return [...prefixRows, ...tailRows];
  }

  clear(): void {
    this.entries = new WeakMap();
    this.arrayEntries = [];
    this.liveEntry = undefined;
    this.sealedEntry = undefined;
    this.streamingEntry = undefined;
  }
}

// ─── sealed transcript prefix (native-scrollback layouts) ───────────────────

export type SealedStaticItem = { index: number; kind: ChatMessage["kind"]; rows: PhysicalRow[] };

export type SealOverlays = {
  subagentById?: Readonly<Record<string, Extract<ChatMessage, { kind: "subagent_call" }>>>;
  toolById?: Readonly<Record<string, Extract<ChatMessage, { kind: "tool_call" }>>>;
};

/**
 * Whether a transcript message has reached its final rendered form.
 *
 * Sealed messages are emitted once through Ink's `<Static>` into the
 * terminal's native scrollback (inline layout mode) and are never re-rendered
 * by the dynamic frame afterwards.
 *
 * - user / assistant / notice / error entries are immutable once appended.
 * - tool cards seal once their lifecycle leaves "running": the result, status
 *   icon and duration are final.
 * - subagent cards stay interactive in pinned frames (expand/collapse and
 *   inner-event updates keep them in the dynamic region — mirroring Gemini
 *   CLI's "tool_group is never static" rule). In burst-channel layouts
 *   (inline/document, `sealedSubagentCards`), FINISHED cards seal into the
 *   native scrollback like any other block: without that, one card pins the
 *   sealed prefix forever and every later streamed answer is re-rendered by
 *   the frame on top of the rows the commit channel already froze.
 *
 * Note: a sealed block's rows are a frozen snapshot. Thinking-mode switches
 * and thinking-expansion toggles only affect the unsealed tail afterwards.
 */
export type SealOptions = {
  /** Burst-channel layouts (inline/document) seal finished subagent cards. */
  sealedSubagentCards?: boolean;
};

export function isSealableTranscriptMessage(
  message: ChatMessage,
  overlays: SealOverlays = {},
  options: SealOptions = {},
): boolean {
  const resolved = resolveTranscriptMessage(message, overlays.subagentById ?? {}, overlays.toolById ?? {});
  if (resolved.kind === "tool_call") return resolved.status !== "running";
  if (resolved.kind === "subagent_call") {
    return options.sealedSubagentCards === true && resolved.status !== "running";
  }
  return true;
}

/** Longest transcript prefix that has reached its final rendered form. */
export function sealedTranscriptCount(
  messages: readonly ChatMessage[],
  overlays: SealOverlays = {},
  options: SealOptions = {},
): number {
  let count = 0;
  while (count < messages.length && isSealableTranscriptMessage(messages[count]!, overlays, options)) count += 1;
  return count;
}

export function streamingAssistantRows(
  streamingText: string,
  options: { width: number; thinkingMode: ThinkingDisplayMode; cache?: MessageHeightCache },
): PhysicalRow[] {
  if (options.cache) {
    return options.cache.getStreamingAssistantRows(streamingText, { width: options.width, thinkingMode: options.thinkingMode });
  }
  return messagePhysicalRows({ kind: "assistant", text: streamingText }, -1, {
    width: options.width,
    thinkingMode: options.thinkingMode,
    expanded: false,
    focused: false,
  });
}

function computeSealedStaticItems(
  messages: ChatMessage[],
  options: {
    width: number;
    thinkingMode: ThinkingDisplayMode;
    expandedThinking: number[];
    subagentById?: Readonly<Record<string, Extract<ChatMessage, { kind: "subagent_call" }>>>;
    toolById?: Readonly<Record<string, Extract<ChatMessage, { kind: "tool_call" }>>>;
    /** Burst-channel layouts seal finished subagent cards (see SealOptions). */
    sealedSubagentCards?: boolean;
  },
  cache?: MessageHeightCache,
): { sealedCount: number; items: SealedStaticItem[] } {
  const expanded = new Set(options.expandedThinking);
  const items: SealedStaticItem[] = [];
  let sealedCount = 0;
  while (sealedCount < messages.length && isSealableTranscriptMessage(messages[sealedCount]!, options, { sealedSubagentCards: options.sealedSubagentCards })) {
    const index = sealedCount;
    const resolved = resolveTranscriptMessage(messages[index]!, options.subagentById ?? {}, options.toolById ?? {});
    // Same projection + cache the dynamic viewport uses, so the static copy is
    // pixel-identical to what the frame showed before the block sealed.
    const rows = cache
      ? cache.get(resolved, index, { width: options.width, thinkingMode: options.thinkingMode, expanded: expanded.has(index) }).rows
      : messagePhysicalRows(resolved, index, {
        width: options.width,
        thinkingMode: options.thinkingMode,
        expanded: expanded.has(index),
        focused: false,
      });
    items.push({ index, kind: resolved.kind, rows });
    sealedCount += 1;
  }
  return { sealedCount, items };
}

/**
 * Build the `<Static>` payload for the sealed transcript prefix. Row arrays are
 * snapshots from the shared height cache; the returned `items` array identity
 * is stable across calls with unchanged inputs (via the cache), so Ink only
 * emits newly sealed items.
 */
export function buildSealedStaticItems(options: {
  messages: ChatMessage[];
  width: number;
  thinkingMode: ThinkingDisplayMode;
  expandedThinking: number[];
  subagentById?: Readonly<Record<string, Extract<ChatMessage, { kind: "subagent_call" }>>>;
  toolById?: Readonly<Record<string, Extract<ChatMessage, { kind: "tool_call" }>>>;
  subagentRevision?: number;
  toolRevision?: number;
  /** Burst-channel layouts seal finished subagent cards (see SealOptions). */
  sealedSubagentCards?: boolean;
  cache?: MessageHeightCache;
}): { sealedCount: number; items: SealedStaticItem[] } {
  if (!options.cache) return computeSealedStaticItems(options.messages, options);
  return options.cache.getSealedStaticEntry(options.messages, options);
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
  // The projection is the single source of truth; reuse it so estimates and
  // rendered rows can never disagree.
  const { width, thinkingMode, expandedThinking, index } = options;
  return messagePhysicalRows(message, index, {
    width,
    thinkingMode,
    expanded: expandedThinking.has(index),
    focused: false,
  }).length;
}

/**
 * Document layout: drop the frozen body rows of the just-finalized streaming
 * message from its frame copy. The commit channel already printed
 * [gap, committed body rows...] into the terminal's native scrollback; while
 * the sealed prefix still stops at an un-sealable entry (a running
 * subagent card), the finalized message stays in the frame's transcript and
 * would re-render those rows. Thinking rows are never committed, so they and
 * the uncommitted tail remain visible.
 */
function applyStreamSealSlice(
  entry: ArrayBlocksEntry,
  options: Parameters<typeof buildBlocks>[0],
): { blocks: HistoryBlock[]; prefixHeights: number[]; totalHeight: number } | undefined {
  const index = options.streamSealPendingIndex;
  const committedTexts = options.committedAssistantTexts;
  if (index === undefined || !committedTexts || committedTexts.length === 0) return undefined;
  const slot = entry.blocks.findIndex(
    (block) => block.item.kind === "message" && block.item.index === index,
  );
  if (slot < 0) return undefined;
  const block = entry.blocks[slot]!;
  if (block.item.kind !== "message" || block.item.message.kind !== "assistant") return undefined;
  const hasMissingEarlierTranscript = entry.blocks.some(
    (candidate, candidateIndex) =>
      candidateIndex < slot &&
      candidate.item.kind === "message" &&
      candidate.item.index !== undefined &&
      candidate.item.index < index,
  );
  if (hasMissingEarlierTranscript) return undefined;
  // The frozen projection carries the leading gap row; count body rows only.
  const committedBody = Math.max(0, committedTexts.length - 1);
  if (committedBody === 0) return undefined;
  let thinkingCount = 0;
  for (const row of block.rows) {
    if (row.key.includes("-thinking") || row.key.includes("-think-")) thinkingCount += 1;
  }
  const bodyStart = 1 + thinkingCount; // rows[0] is the block's gap row
  const drop = Math.min(committedBody, Math.max(0, block.rows.length - bodyStart));
  if (drop === 0) return undefined;
  const rows = [...block.rows.slice(0, bodyStart), ...block.rows.slice(bodyStart + drop)];
  const blocks = [...entry.blocks];
  blocks[slot] = { ...block, height: rows.length, rows };
  const prefixHeights: number[] = [];
  let totalHeight = 0;
  for (const next of blocks) {
    totalHeight += next.height;
    prefixHeights.push(totalHeight);
  }
  return { blocks, prefixHeights, totalHeight };
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
  /** First transcript index owned by the dynamic frame; earlier rows are sealed. */
  historyStartIndex?: number;
  /** Document layout: live text renders the committed-prefix projection minus streamed rows. */
  documentMode?: boolean;
  /** Rows of the streaming assistant projection already appended to the stream. */
  committedStreamingRows?: number;
  /** Document layout: final assistant rows already frozen before an un-sealable entry. */
  sealedAssistantRows?: readonly PhysicalRow[];
  /** Row texts from the streaming projection already frozen into scrollback. */
  committedAssistantTexts?: readonly string[];
  /** Transcript index of the just-finalized streaming message whose frozen body rows must not re-render in the frame. */
  streamSealPendingIndex?: number;
  cache?: MessageHeightCache;
  subagentById?: Readonly<Record<string, Extract<ChatMessage, { kind: "subagent_call" }>>>;
  toolById?: Readonly<Record<string, Extract<ChatMessage, { kind: "tool_call" }>>>;
  subagentRevision?: number;
  toolRevision?: number;
  subagentChange?: DynamicChange;
  toolChange?: DynamicChange;
}): { historyBlocks: HistoryBlock[]; prefixHeights: number[]; liveBlocks: HistoryBlock[]; totalHeight: number } {
  const entry = options.cache
    ? options.cache.getHistoryEntry(options.messages, {
      width: options.width,
      thinkingMode: options.thinkingMode,
      expandedThinking: options.expandedThinking,
      maxMessages: options.maxMessages,
      historyStartIndex: options.historyStartIndex,
      subagentById: options.subagentById,
      toolById: options.toolById,
      subagentRevision: options.subagentRevision,
      toolRevision: options.toolRevision,
      subagentChange: options.subagentChange,
      toolChange: options.toolChange,
    })
    : fallbackHistoryEntry(options);
  const buildLiveBlocks = (): HistoryBlock[] => {
    const live: HistoryBlock[] = [];
    const reasoningRows = options.streamingReasoning
      ? streamingPhysicalRows({
        streamingText: "",
        streamingReasoning: options.streamingReasoning,
        busy: options.busy,
        width: options.width,
        reasoningMode: options.thinkingMode,
      })
      : [];
    if (reasoningRows.length > 0) {
      // Live stack spacing convention: only the FIRST live row carries the
      // 1-row gap so the stack previews the next history assistant block.
      live.push({
        item: { kind: "streaming_reasoning" },
        height: 1 + reasoningRows.length,
        rows: [gapRow("live-gap"), ...reasoningRows],
      });
    }
    if (options.streamingText) {
      if (options.documentMode) {
        if (options.sealedAssistantRows && options.committedAssistantTexts) {
          const rows = assistantSealRemainingRows(options.sealedAssistantRows, options.committedAssistantTexts);
          if (rows.length > 0) {
            live.push({ item: { kind: "streaming_text" }, height: rows.length, rows });
          }
        } else {
          let rows: PhysicalRow[];
          const allRows = streamingAssistantRows(options.streamingText, {
            width: options.width,
            thinkingMode: options.thinkingMode,
            cache: options.cache,
          });
          const floor = Math.min(options.committedStreamingRows ?? 0, allRows.length);
          rows = allRows.slice(floor);
          live.push({ item: { kind: "streaming_text" }, height: Math.max(1, rows.length), rows });
        }
      } else {
        const textRows = streamingPhysicalRows({
          streamingText: options.streamingText,
          streamingReasoning: "",
          busy: options.busy,
          width: options.width,
          reasoningMode: options.thinkingMode,
        });
        const topMargin = options.streamingReasoning ? 0 : 1;
        const rows = [...(topMargin ? [gapRow("live-gap-text")] : []), ...textRows];
        live.push({ item: { kind: "streaming_text" }, height: Math.max(1, rows.length), rows });
      }
    }
    if (options.busy) {
      const topMargin = options.streamingReasoning || options.streamingText ? 0 : 1;
      const rows = [...(topMargin ? [gapRow("live-gap-busy")] : []), busyRow()];
      live.push({ item: { kind: "busy_status" }, height: rows.length, rows });
    }
    return live;
  };
  const liveBlocks = options.cache
    ? options.cache.getLiveBlocks({
      streamingText: options.streamingText,
      streamingReasoning: options.streamingReasoning,
      busy: options.busy,
      thinkingMode: options.thinkingMode,
      width: options.width,
      documentMode: options.documentMode ?? false,
      committedStreamingRows: options.committedStreamingRows ?? 0,
      sealedAssistantRows: options.sealedAssistantRows,
      committedAssistantTexts: options.committedAssistantTexts,
    }, buildLiveBlocks)
    : buildLiveBlocks();
  const liveTotalHeight = liveBlocks.reduce((sum, block) => sum + block.height, 0);
  // Document layout: drop the frozen body rows of the just-finalized message
  // from its frame copy (see applyStreamSealSlice).
  const sealSlice = options.documentMode ? applyStreamSealSlice(entry, options) : undefined;
  return {
    historyBlocks: sealSlice ? sealSlice.blocks : entry.blocks,
    prefixHeights: sealSlice ? sealSlice.prefixHeights : entry.prefixHeights,
    liveBlocks,
    totalHeight: (sealSlice ? sealSlice.totalHeight : entry.totalHeight) + liveTotalHeight,
  };
}

function gapRow(key: string): PhysicalRow {
  return { key, text: "", style: "assistant" };
}

function busyRow(): PhysicalRow {
  return { key: "busy-status", text: "", style: "muted" };
}

function fallbackHistoryEntry(options: Parameters<typeof buildBlocks>[0]): ArrayBlocksEntry {
  const blockStart = Math.max(0, options.messages.length - options.maxMessages, options.historyStartIndex ?? 0);
  const expanded = new Set(options.expandedThinking);
  const blocks: HistoryBlock[] = [];
  const prefixHeights: number[] = [];
  let totalHeight = 0;
  for (let index = blockStart; index < options.messages.length; index++) {
    const message = resolveTranscriptMessage(options.messages[index]!, options.subagentById ?? {}, options.toolById ?? {});
    const rows = messagePhysicalRows(message, index, {
      width: options.width,
      thinkingMode: options.thinkingMode,
      expanded: expanded.has(index),
      focused: false,
    });
    blocks.push({ item: { kind: "message", index, message }, height: rows.length, rows });
    totalHeight += rows.length;
    prefixHeights.push(totalHeight);
  }
  return {
    messages: options.messages,
    width: options.width,
    thinkingMode: options.thinkingMode,
    expandedKey: options.expandedThinking.join(","),
    maxMessages: options.maxMessages,
    historyStartIndex: blockStart,
    subagentById: options.subagentById,
    toolById: options.toolById,
    subagentRevision: options.subagentRevision ?? 0,
    toolRevision: options.toolRevision ?? 0,
    blocks,
    prefixHeights,
    totalHeight,
  };
}

export function estimateViewportContentHeight(options: Omit<Parameters<typeof selectMessageViewport>[0], "scrollOffset" | "availableHeight"> & { cache?: MessageHeightCache }): number {
  return buildBlocks({ ...options, maxMessages: options.maxMessages ?? Number.MAX_SAFE_INTEGER }).totalHeight;
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

/** Build a bottom-anchored, row-addressable viewport over physical rows. */
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
  /**
   * First transcript index owned by the dynamic frame. Sealed rows (already
   * emitted into the terminal's native scrollback via `<Static>`) are excluded
   * from scroll accounting, hints, and the rendered frame.
   */
  historyStartIndex?: number;
  /** Document layout: live text renders the committed-prefix projection minus streamed rows. */
  documentMode?: boolean;
  /** Rows of the streaming assistant projection already appended to the stream. */
  committedStreamingRows?: number;
  /** Document layout: final assistant rows already frozen before an un-sealable entry. */
  sealedAssistantRows?: readonly PhysicalRow[];
  /** Row texts from the streaming projection already frozen into scrollback. */
  committedAssistantTexts?: readonly string[];
  /** Transcript index of the just-finalized streaming message whose frozen body rows must not re-render in the frame. */
  streamSealPendingIndex?: number;
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
    const visibleStart = Math.max(blockStart, startRow);
    const visibleEnd = Math.min(blockEnd, endRow);
    if (visibleStart >= visibleEnd) return;
    const clipTop = visibleStart - blockStart;
    const rows = block.rows.slice(clipTop, clipTop + (visibleEnd - visibleStart));
    items.push({
      ...block.item,
      clipTop,
      visibleHeight: visibleEnd - visibleStart,
      rows,
    } as ViewportItem);
  };

  // History blocks are indexed by prefix sums. Locate the visible tail with
  // binary search, then visit only the blocks that can contribute rows.
  const historyPrefix = collection.prefixHeights;
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
