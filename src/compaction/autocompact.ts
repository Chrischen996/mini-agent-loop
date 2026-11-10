/**
 * Claude Code-style layered context compaction.
 *
 * Three layers, applied in this order, mirroring the pipeline Claude Code
 * uses in `src/query.ts`:
 *
 *   1. {@link applyToolResultBudget} — clear oversized tool payloads while
 *      keeping the message structure intact (cheap, lossless enough).
 *   2. {@link compactByTokenThreshold} — summarize old messages once the
 *      conversation approaches the model's context window, with a predictive
 *      check that compacts *before* the next turn would overflow.
 *   3. The legacy destructive {@link compactHistory} as a last resort when the
 *      provider reports a hard context overflow.
 */

import { compactHistory, estimateContextTokens } from "../context.ts";
import { applyToolResultBudget, type ToolResultBudgetOptions } from "./tool-result-budget.ts";
import type { Tool } from "../tools/types.ts";
import type { AgentMessage } from "../types.ts";

/** Claude Code's default autocompact buffer for small/medium context windows. */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;

/** Claude Code's buffer for >= 400K context windows. */
export const LARGE_WINDOW_BUFFER_TOKENS = 30_000;

/** Claude Code's buffer for >= 800K context windows. */
export const XL_WINDOW_BUFFER_TOKENS = 50_000;

/**
 * Conservative estimate of how many tokens one turn can add. Claude Code
 * uses the same shape: max output tokens plus an allowance for a single
 * large tool result.
 */
export const TOOL_RESULT_GROWTH_ESTIMATE = 15_000;

/** Max output tokens reserved for a compaction summary. */
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;

/**
 * Stop retrying autocompact after this many consecutive failures. Claude
 * Code added this after 1,279 sessions burned 250K API calls/day on
 * hopeless prompt_too_long retries.
 */
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

export type AutocompactOptions = {
  /** Model context window. */
  contextWindow: number;
  /** Model max output tokens. */
  maxOutputTokens?: number;
  /**
   * Token budget the conversation must stay under (contextWindow minus any
   * reserve). When provided, this is the compaction threshold; otherwise it is
   * derived from the context window. Kept explicit so callers share one budget
   * definition with other compaction paths.
   */
  budgetTokens?: number;
  /** Override the effective context window (testing / tuning). */
  contextWindowOverride?: number;
  /** Number of recent messages to keep verbatim. */
  keepRecentMessages?: number;
  /** Tool-result budget options. */
  toolResultBudget?: ToolResultBudgetOptions;
};

export type AutocompactResult = {
  /** The messages to send to the model. */
  messages: AgentMessage[];
  /** Whether anything was compacted. */
  compacted: boolean;
  /** Token count before compaction. */
  beforeTokens: number;
  /** Token count after compaction. */
  afterTokens: number;
  /** Why compaction ran (or did not). */
  reason: string;
  /** Tool result ids that were cleared. */
  clearedToolCallIds: string[];
  /** Tool ids that were cleared. */
  tokensFreed: number;
  /** Consecutive failure counter for the circuit breaker. */
  consecutiveFailures: number;
};

/**
 * The context window available for the conversation, minus room reserved for
 * the compaction summary itself.
 */
export function getEffectiveContextWindowSize(options: AutocompactOptions): number {
  const window = options.contextWindowOverride ?? options.contextWindow;
  const reserved = Math.min(
    options.maxOutputTokens ?? MAX_OUTPUT_TOKENS_FOR_SUMMARY,
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
    Math.floor(window * 0.5),
  );
  return Math.max(1, window - reserved);
}

/**
 * Context-aware autocompact buffer. Larger windows get more headroom because
 * a single turn can produce proportionally more output. For small windows the
 * buffer is capped to a fraction of the window so a short conversation is
 * never treated as "over the limit".
 */
export function getAutocompactBufferTokens(options: AutocompactOptions): number {
  const effective = getEffectiveContextWindowSize(options);
  if (effective >= 800_000) return XL_WINDOW_BUFFER_TOKENS;
  if (effective >= 400_000) return LARGE_WINDOW_BUFFER_TOKENS;
  // Never reserve more than 25% of a small window as headroom.
  return Math.min(AUTOCOMPACT_BUFFER_TOKENS, Math.floor(effective * 0.25));
}

/**
 * The token count at which autocompact fires. When the caller supplies an
 * explicit `budgetTokens`, that is the threshold source; otherwise it derives
 * from the context window minus the autocompact headroom.
 */
export function getAutoCompactThreshold(options: AutocompactOptions): number {
  if (options.budgetTokens !== undefined) {
    const headroom = Math.min(getAutocompactBufferTokens(options), Math.floor(options.budgetTokens * 0.25));
    return Math.max(1, options.budgetTokens - headroom);
  }
  return Math.max(
    1,
    getEffectiveContextWindowSize(options) - getAutocompactBufferTokens(options),
  );
}

/**
 * Run the layered compaction pipeline.
 *
 * Layer 1 (tool result budget) runs first because it is cheap and does not
 * call the model. Layer 2 (token-threshold summary) only runs when the
 * conversation is genuinely near the context limit.
 */
export function runAutocompact(
  messages: AgentMessage[],
  tools: Tool[],
  options: AutocompactOptions,
  state: { consecutiveFailures?: number } = {},
): AutocompactResult {
  const beforeTokens = estimateContextTokens(messages, tools);
  const threshold = getAutoCompactThreshold(options);
  const toolTokens = estimateContextTokens([], tools);
  const conversationTokens = Math.max(0, beforeTokens - toolTokens);

  let current = messages;
  let clearedToolCallIds: string[] = [];
  let tokensFreed = 0;

  // ── Layer 1: tool result budget ──────────────────────────────────────────
  const budgeted = applyToolResultBudget(current, options.toolResultBudget);
  if (budgeted.messages !== current) {
    current = budgeted.messages;
    clearedToolCallIds = budgeted.clearedToolCallIds;
    tokensFreed += budgeted.tokensFreed;
  }

  const afterBudgetTokens = estimateContextTokens(current, tools);
  const conversationTokensAfterBudget = Math.max(0, afterBudgetTokens - toolTokens);

  // ── Layer 2: token-threshold summary compaction ──────────────────────────
  // Only compact when the conversation genuinely exceeds the threshold. No
  // predictive compression: a short conversation must stay untouched.
  const needsCompaction = conversationTokensAfterBudget > threshold;

  if (!needsCompaction) {
    return {
      messages: current,
      compacted: clearedToolCallIds.length > 0,
      beforeTokens,
      afterTokens: afterBudgetTokens,
      reason: clearedToolCallIds.length > 0 ? "tool result budget" : "within budget",
      clearedToolCallIds,
      tokensFreed,
      consecutiveFailures: state.consecutiveFailures ?? 0,
    };
  }

  // Circuit breaker: stop retrying a context we cannot shrink.
  const failures = state.consecutiveFailures ?? 0;
  if (failures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    return {
      messages: current,
      compacted: clearedToolCallIds.length > 0,
      beforeTokens,
      afterTokens: afterBudgetTokens,
      reason: "autocompact failure limit reached",
      clearedToolCallIds,
      tokensFreed,
      consecutiveFailures: failures,
    };
  }

  const compacted = compactHistory(current, {
    keepRecentMessages: options.keepRecentMessages,
    maxTokens: Math.max(1, threshold - toolTokens),
  });
  const afterTokens = estimateContextTokens(compacted, tools);

  if (compacted === current) {
    return {
      messages: current,
      compacted: clearedToolCallIds.length > 0,
      beforeTokens,
      afterTokens: afterBudgetTokens,
      reason: "not compactable",
      clearedToolCallIds,
      tokensFreed,
      consecutiveFailures: failures + 1,
    };
  }

  return {
    messages: compacted,
    compacted: true,
    beforeTokens,
    afterTokens,
    reason: "token budget",
    clearedToolCallIds,
    tokensFreed,
    consecutiveFailures: 0,
  };
}
