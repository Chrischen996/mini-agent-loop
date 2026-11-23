// Inline/document layout stream emission for the Ink session view.
//
// Two channels feed the terminal:
//
// 1. The dynamic Ink frame (what React renders every tick), which only holds
//    the unsealed tail plus chrome.
// 2. The static-burst channel (`writeStaticBurst`), which writes finalized
//    transcript rows straight into the terminal's native scrollback.
//
// This hook owns the second channel: it decides what is sealed, tracks how much
// of it was already emitted per transcript generation, appends closed streaming
// paragraphs in document mode, and reprints the visible window on resize.
//
// Invariants (do not weaken):
// - without an emitter (tests render App directly, alternate layout) nothing is
//   sliced out of the frame, or sealed history would vanish from the screen;
// - rows are emitted at most once per transcript generation, and a swapped
//   transcript (reset / restore) re-emits from scratch;
// - a retried stream keeps its frozen prefix and only emits the remainder.

import { useLayoutEffect, useMemo, useRef } from "react";
import type { Dispatch, MutableRefObject } from "react";
import type { ChatMessage, TuiAction, TuiState } from "../state.ts";
import {
  buildSealedStaticItems,
  type MessageHeightCache,
  streamingAssistantRows,
  type SealedStaticItem,
} from "../message-viewport.ts";
import { messagePhysicalRows, type PhysicalRow } from "../message-rows.ts";
import {
  assistantSealRemainingRows,
  collectResizeRefreshRows,
  computeCommitBoundary,
  rowTexts,
} from "../stream-commit.ts";
import { formatSealedRowsText } from "../components/MessageFeed.tsx";
import { headerStaticText } from "../components/Header.tsx";

type StreamLedger = {
  offset: number;
  rowCount: number;
  width: number;
  lastText: string;
  texts: string[];
};

/**
 * Whether `next` continues `prev` as a reasoning-placeholder replacement
 * instead of swapping the transcript (reset / restore / rewind). The reducer
 * replaces a reasoning-only placeholder assistant (empty answer text, kept
 * for its thinking rows) with the final answer in one swap: one middle entry
 * drops, the answer appends, length unchanged. That swap keeps the emission
 * position — re-emitting the whole sealed prefix over the live conversation
 * is exactly the "extra layer above the user message" duplication.
 *
 * Returns the transcript index of the dropped placeholder, or -1 when the
 * arrays are not a placeholder replacement.
 */
function placeholderReplacementIndex(
  prev: readonly ChatMessage[],
  next: readonly ChatMessage[],
): number {
  if (prev.length < 2 || next.length !== prev.length || next[0] !== prev[0]) return -1;
  const appended = next[next.length - 1]!;
  if (appended.kind !== "assistant" || appended.text === "") return -1;
  for (let skip = 0; skip < prev.length; skip += 1) {
    const dropped = prev[skip]!;
    if (dropped.kind !== "assistant" || dropped.text !== "") continue;
    let matches = true;
    for (let prevCursor = 0; prevCursor < prev.length; prevCursor += 1) {
      if (prevCursor === skip) continue;
      const nextCursor = prevCursor < skip ? prevCursor : prevCursor - 1;
      if (next[nextCursor] !== prev[prevCursor]) { matches = false; break; }
    }
    if (matches) return skip;
  }
  return -1;
}

export type UseStreamBurstsOptions = {
  state: TuiState;
  dispatchRef: MutableRefObject<Dispatch<TuiAction>>;
  /** Inline or document layout: sealed rows go to the native scrollback. */
  usesStreamChannel: boolean;
  /** Document layout: the header and live paragraphs stream too. */
  isDocumentLayout: boolean;
  writeStaticBurst?: (text: string) => void;
  termWidth: number;
  termHeight: number;
  cwd: string;
  /** Inactive sessions must never print into the shared terminal. */
  active: boolean;
  heightCache: MessageHeightCache;
  /** Bumped when the theme changes so the visible window is reprinted once. */
  resizeRefreshRef: MutableRefObject<number>;
};

export type StreamBursts = {
  /** Messages that reached their final form; the frame starts after them. */
  sealedStatic: { sealedCount: number; items: SealedStaticItem[] };
  /** Generation counter for the transcript array (see the hook body). */
  generation: number;
  /** Index of the assistant message waiting to be sealed, when known. */
  streamSealPendingIndex: number | undefined;
  /** Full physical rows of the pending assistant message. */
  sealedPendingAssistantRows: PhysicalRow[] | undefined;
  /** Row texts already frozen for the pending assistant message. */
  committedPendingAssistantTexts: string[] | undefined;
  /** Document mode: live rows already committed to the stream. */
  committedStreamingRows: number;
};

export function useStreamBursts(options: UseStreamBurstsOptions): StreamBursts {
  const {
    state,
    dispatchRef,
    usesStreamChannel,
    isDocumentLayout,
    writeStaticBurst,
    termWidth,
    termHeight,
    cwd,
    active,
    heightCache,
    resizeRefreshRef,
  } = options;

  // The emission position is tracked per transcript GENERATION: append-only
  // growth of `state.messages` keeps it, any other array swap (RESET, session
  // restore, rewind) resets it so the swapped transcript re-emits from
  // scratch while ordinary appends never re-emit sealed rows.
  const sealedGenerationRef = useRef({ array: state.messages, generation: 0 });
  if (sealedGenerationRef.current.array !== state.messages) {
    const previous: ChatMessage[] = sealedGenerationRef.current.array;
    const appendOnly = previous.length > 0 &&
      state.messages.length >= previous.length &&
      state.messages[0] === previous[0] &&
      state.messages[previous.length - 1] === previous[previous.length - 1];
    // The reducer replaces a reasoning-only placeholder (empty answer text)
    // with the final answer in one swap that drops the middle placeholder and
    // appends the answer. That is a CONTENT continuation of the same
    // transcript, not a swap: re-emitting the whole sealed prefix over the
    // live conversation is exactly the "extra layer above the user message"
    // duplicate.
    const placeholderReplaced = placeholderReplacementIndex(previous, state.messages) >= 0;
    sealedGenerationRef.current = {
      array: state.messages,
      generation: appendOnly || placeholderReplaced
        ? sealedGenerationRef.current.generation
        : sealedGenerationRef.current.generation + 1,
    };
  }

  const sealedStatic = useMemo(() => {
    // The sealed split requires the burst channel: without an emitter (tests
    // render App directly, alternate layout), every row must stay in the
    // dynamic frame or sealed history would vanish from the screen entirely.
    if (!usesStreamChannel || !writeStaticBurst) return { sealedCount: 0, items: [] };
    return buildSealedStaticItems({
      messages: state.messages,
      width: termWidth,
      thinkingMode: state.thinkingMode,
      expandedThinking: state.expandedThinking,
      subagentById: state.subagentById,
      toolById: state.toolById,
      subagentRevision: state.subagentRevision,
      toolRevision: state.toolRevision,
      sealedSubagentCards: true,
      cache: heightCache,
    });
  }, [
    usesStreamChannel,
    writeStaticBurst,
    state.messages,
    termWidth,
    state.thinkingMode,
    state.expandedThinking,
    state.subagentById,
    state.toolById,
    state.subagentRevision,
    state.toolRevision,
    heightCache,
  ]);

  // Document layout ledger: rows of the streaming assistant projection that
  // were already appended to the stream. Sealing the finalized message must
  // only emit the uncommitted remainder (longest-common-prefix dedup).
  const streamLedgerRef = useRef<StreamLedger>({ offset: 0, rowCount: 0, width: 0, lastText: "", texts: [] });

  // Render-side floor for the live text block: identical pure computation the
  // commit effect performs, so the frame tail and the stream never overlap.
  // Without the burst channel (tests render App directly) nothing may be
  // sliced out of the frame or the streamed rows would vanish.
  const streamRetryBaseline = state.streamRetryCommittedText;
  // The commit channel only appends streamed rows once every transcript entry
  // except the newest has sealed. A running subagent card or tool holds the
  // seal boundary; committing then would land the answer ahead of that card
  // in document order. The frame floor shares this predicate so held-back
  // rows stay visible in the frame instead of vanishing from both channels.
  const flowCommitActive = isDocumentLayout && writeStaticBurst !== undefined
    && sealedStatic.sealedCount >= state.messages.length - 1;
  const pendingAssistantIndex = state.streamSealPending
    ? state.messages.indexOf(state.streamSealPending.message)
    : -1;
  const streamSealPendingIndex = flowCommitActive && pendingAssistantIndex >= 0 ? pendingAssistantIndex : undefined;
  const sealedPendingAssistantRows = state.streamSealPending && pendingAssistantIndex >= 0 && flowCommitActive
    ? messagePhysicalRows(state.streamSealPending.message, pendingAssistantIndex, {
      width: termWidth,
      thinkingMode: state.thinkingMode,
      expanded: state.expandedThinking.includes(pendingAssistantIndex),
      focused: false,
    })
    : undefined;
  const committedPendingAssistantTexts = state.streamSealPending && flowCommitActive
    ? state.streamSealPending.committedText
      ? rowTexts(streamingAssistantRows(state.streamSealPending.committedText, {
        width: termWidth,
        thinkingMode: state.thinkingMode,
        cache: heightCache,
      }))
      : []
    : undefined;
  const committedStreamingRows = flowCommitActive && state.streamingText
    ? streamingAssistantRows(state.streamingText.slice(0, streamRetryBaseline ? 0 : computeCommitBoundary(state.streamingText)), {
      width: termWidth,
      thinkingMode: state.thinkingMode,
      cache: heightCache,
    }).length
    : 0;

  // Document layout: the identity header is part of the stream, not the
  // frame — printed once per transcript generation (and on model/cwd change)
  // above the first rows, then it scrolls away with the conversation.
  const headerBurstRef = useRef({ generation: -1, signature: "" });
  useLayoutEffect(() => {
    if (!isDocumentLayout || !writeStaticBurst) return;
    const generation = sealedGenerationRef.current.generation;
    const signature = `${state.modelName ?? ""}|${cwd}`;
    if (headerBurstRef.current.generation === generation && headerBurstRef.current.signature === signature) return;
    headerBurstRef.current = { generation, signature };
    writeStaticBurst(`${headerStaticText({ width: termWidth, modelName: state.modelName, cwd })}\n`);
  }, [isDocumentLayout, writeStaticBurst, state.modelName, cwd, termWidth, state.messages]);

  // Emit newly sealed transcript rows into the native scrollback. Layout
  // effects run synchronously after the commit but before Ink's throttled
  // frame render, so the burst lands above the frame that follows it.
  const emittedStaticRef = useRef({ generation: -1, count: 0 });
  useLayoutEffect(() => {
    if (!usesStreamChannel || !writeStaticBurst) return;
    const tracked = emittedStaticRef.current;
    const generation = sealedGenerationRef.current.generation;
    if (tracked.generation !== generation) {
      tracked.generation = generation;
      tracked.count = 0;
    }
    if (sealedStatic.items.length <= tracked.count) return;
    const pending = sealedStatic.items.slice(tracked.count);
    tracked.count = sealedStatic.items.length;
    const ledger = streamLedgerRef.current;
    // Read the baseline straight from state: the reducer keeps it alive
    // through the assistant seal event (this effect is what clears it),
    // so a pure-text turn with no intermediate sealed items still dedupes
    // its retried stream against the frozen prefix. Only the FIRST sealed
    // assistant item of this batch may use it: later assistant messages
    // belong to fresh turns whose streams were not committed.
    let activeRetryBaseline = state.streamRetryCommittedText;
    const hadRetryBaseline = activeRetryBaseline !== undefined;
    for (const item of pending) {
      let rows = item.rows;
      if (isDocumentLayout && item.kind === "assistant") {
        // The streamed prefix is already frozen in the scrollback; skip it.
        const baselineRows = activeRetryBaseline
          ? streamingAssistantRows(activeRetryBaseline, {
            width: termWidth,
            thinkingMode: state.thinkingMode,
            cache: heightCache,
          })
          : [];
        const committedTexts: string[] = [...rowTexts(baselineRows), ...ledger.texts];
        // Each projection starts with the shared blank gap row; drop the seam
        // gap so the prefix match stays contiguous across a retry boundary.
        if (baselineRows.length > 0 && ledger.texts.length > 0 && committedTexts[baselineRows.length] === "") {
          committedTexts.splice(baselineRows.length, 1);
        }
        if (committedTexts.length > 0) {
          rows = assistantSealRemainingRows(rows, committedTexts);
        }
        ledger.offset = 0;
        ledger.rowCount = 0;
        ledger.texts = [];
        ledger.lastText = "";
        activeRetryBaseline = undefined;
      }
      if (rows.length > 0) writeStaticBurst(formatSealedRowsText(rows));
    }
    // Clear the state baseline whenever this batch observed one, even if the
    // assistant item consumed it: commit suppression must not outlive the
    // retried stream, or the next turn's streamed rows would be held back.
    if (isDocumentLayout && hadRetryBaseline) {
      dispatchRef.current({ type: "CLEAR_STREAM_RETRY_BASELINE" });
    }
  }, [usesStreamChannel, isDocumentLayout, writeStaticBurst, sealedStatic, termWidth, state.thinkingMode, state.streamRetryCommittedText, heightCache, dispatchRef]);

  // Document layout: append closed streaming paragraphs into the terminal
  // stream as they complete (fences/tables held back by computeCommitBoundary
  // until the block closes), so the whole conversation scrolls as one flow.
  // While a truncated stream is being retried the frozen prefix cannot be
  // retracted; one dim marker separates it from the regenerated answer so
  // the two copies read as "kept draft + regeneration" instead of a
  // duplicated reply.
  const retryNoteEmittedRef = useRef(false);
  useLayoutEffect(() => {
    if (!isDocumentLayout || !writeStaticBurst) return;
    const ledger = streamLedgerRef.current;
    if (state.streamRetryCommittedText) {
      if (!retryNoteEmittedRef.current) {
        retryNoteEmittedRef.current = true;
        writeStaticBurst(formatSealedRowsText([{
          key: "stream-retry-note",
          text: "· Connection lost — the partial answer above is kept while the request retries",
          style: "muted",
          dim: true,
        }]));
      }
      // The prefix before this retry is already frozen. Keep it for seal dedup,
      // but never append the regenerated stream until the turn is final.
      ledger.lastText = "";
      ledger.offset = 0;
      ledger.rowCount = 0;
      ledger.width = termWidth;
      return;
    }
    retryNoteEmittedRef.current = false;
    const text = state.streamingText;
    if (!text) return;
    if (!flowCommitActive) return;
    if (!text.startsWith(ledger.lastText)) {
      // Fresh stream generation (previous turn consumed or interrupted).
      ledger.offset = 0;
      ledger.rowCount = 0;
      ledger.texts = [];
      ledger.width = termWidth;
    }
    ledger.lastText = text;
    const project = (upto: number) =>
      streamingAssistantRows(text.slice(0, upto), { width: termWidth, thinkingMode: state.thinkingMode, cache: heightCache });
    if (ledger.width !== termWidth) {
      // Width flip mid-stream: rows already frozen keep their old wrap;
      // rebaseline the ledger so the live floor and dedup stay aligned.
      ledger.width = termWidth;
      const base = project(ledger.offset);
      ledger.rowCount = base.length;
      ledger.texts = rowTexts(base);
    }
    const boundary = computeCommitBoundary(text);
    if (boundary <= ledger.offset) return;
    const rows = project(boundary);
    const fresh = rows.slice(ledger.rowCount);
    ledger.offset = boundary;
    ledger.rowCount = rows.length;
    ledger.texts = rowTexts(rows);
    if (fresh.length > 0) writeStaticBurst(formatSealedRowsText(fresh));
  }, [isDocumentLayout, writeStaticBurst, state.streamingText, termWidth, state.thinkingMode, state.messages.length, sealedStatic.sealedCount, heightCache]);

  // Resize refresh (gemini-cli style): when the terminal WIDTH changes, the
  // rows already frozen into the scrollback carry a stale wrap. Re-print the
  // newest window (at least one screen, budget-capped) at the new width;
  // older copies remain in the scrollback, the visible region becomes
  // correct again. Document mode additionally refreshes the committed
  // streaming prefix so the in-flight message stays readable.
  useLayoutEffect(() => {
    // Inactive sessions must not print into the shared terminal; when the
    // session later activates with a changed width, this effect fires the
    // refresh once (the ref intentionally stays stale while inactive).
    if (!active || !usesStreamChannel || !writeStaticBurst) return;
    if (resizeRefreshRef.current === termWidth) return;
    resizeRefreshRef.current = termWidth;
    if (sealedStatic.items.length > 0) {
      const window = collectResizeRefreshRows(sealedStatic.items, { minRows: termHeight });
      if (window.length > 0) writeStaticBurst(formatSealedRowsText(window));
    }
    if (flowCommitActive && state.streamingText) {
      const boundary = computeCommitBoundary(state.streamingText);
      if (boundary > 0) {
        const rows = streamingAssistantRows(state.streamingText.slice(0, boundary), {
          width: termWidth,
          thinkingMode: state.thinkingMode,
          cache: heightCache,
        });
        const tail = rows.slice(Math.max(0, rows.length - termHeight));
        if (tail.length > 0) writeStaticBurst(formatSealedRowsText(tail));
      }
    }
  }, [active, usesStreamChannel, isDocumentLayout, writeStaticBurst, termWidth, termHeight, sealedStatic, state.streamingText, state.thinkingMode, resizeRefreshRef, heightCache, flowCommitActive]);

  return {
    sealedStatic,
    generation: sealedGenerationRef.current.generation,
    streamSealPendingIndex,
    sealedPendingAssistantRows,
    committedPendingAssistantTexts,
    committedStreamingRows,
  };
}
