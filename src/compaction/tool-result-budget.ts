/**
 * Token-budget trimming for tool results.
 *
 * Mirrors Claude Code's `microcompact` behaviour: tool results are the
 * fastest-growing part of a long conversation (file reads, bash output,
 * grep hits), so they are cleared once the conversation gets long. The
 * message *structure* is preserved — only the payload is replaced — so the
 * model still sees that the tool ran and what it returned.
 */

import { contentAsString } from "../content.ts";
import { estimateTextTokens } from "../context.ts";
import type { AgentMessage } from "../types.ts";

/** Tools whose results are worth compacting first. */
export const COMPACTABLE_TOOLS = new Set([
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "web_search",
  "fetch_content",
  "get_search_content",
  "codebase_read",
  "codebase_search",
  "codebase_explain",
  "document_edit",
]);

/** Minimum conversation length before microcompact may run. */
export const MICROCOMPACT_MIN_MESSAGES = 30;

/** Default per-result character budget. */
export const DEFAULT_TOOL_RESULT_BUDGET_CHARS = 8_000;

const CLEARED_PREFIX = "[tool result cleared to reclaim context — ";

export type ToolResultBudgetOptions = {
  /** Per-result character budget. */
  budgetChars?: number;
  /** Only compact these tool names. Defaults to {@link COMPACTABLE_TOOLS}. */
  compactableTools?: Set<string>;
  /** Minimum messages before compaction is allowed. */
  minMessages?: number;
  /** Keep the newest N tool results untouched. */
  keepRecent?: number;
};

export type ToolResultBudgetResult = {
  messages: AgentMessage[];
  /** Ids of tool results whose payload was cleared. */
  clearedToolCallIds: string[];
  /** Rough number of tokens reclaimed. */
  tokensFreed: number;
};

function toolResultText(message: AgentMessage): string {
  return contentAsString(message.content);
}

/**
 * True when the tool result exceeds the per-result budget.
 */
export function exceedsToolResultBudget(
  message: AgentMessage,
  budgetChars: number,
): boolean {
  if (message.role !== "tool") return false;
  return toolResultText(message).length > budgetChars;
}

/**
 * Replace an oversized tool result payload with a short marker that keeps
 * the head and tail of the original output. Structure (role, toolCallId,
 * name, isError) is untouched so the tool-call/result pairing stays valid.
 */
export function clearToolResultContent(
  message: AgentMessage,
  budgetChars: number,
): AgentMessage {
  if (message.role !== "tool") return message;
  const text = toolResultText(message);
  if (text.length <= budgetChars) return message;

  const headSize = Math.floor(budgetChars * 0.7);
  const tailSize = Math.max(0, budgetChars - headSize);
  const head = text.slice(0, headSize);
  const tail = tailSize > 0 ? text.slice(-tailSize) : "";
  const omitted = text.length - headSize - tailSize;
  const marker = `${CLEARED_PREFIX}${omitted.toLocaleString()} characters omitted]`;
  const replacement = tail ? `${head}\n\n${marker}\n\n${tail}` : `${head}\n\n${marker}`;

  return { ...message, content: replacement };
}

/**
 * Trim oversized tool results across a conversation.
 *
 * The newest `keepRecent` tool results are left alone so the model keeps
 * full fidelity for what it just did; older ones are cleared down to the
 * per-result budget. Messages that are not tool results are never touched.
 */
export function applyToolResultBudget(
  messages: AgentMessage[],
  options: ToolResultBudgetOptions = {},
): ToolResultBudgetResult {
  const budgetChars = options.budgetChars ?? DEFAULT_TOOL_RESULT_BUDGET_CHARS;
  const compactable = options.compactableTools ?? COMPACTABLE_TOOLS;
  const minMessages = options.minMessages ?? MICROCOMPACT_MIN_MESSAGES;
  const keepRecent = options.keepRecent ?? 0;

  if (messages.length < minMessages) {
    return { messages, clearedToolCallIds: [], tokensFreed: 0 };
  }

  const toolIndexes: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "tool" && compactable.has(message.name)) {
      toolIndexes.push(index);
    }
  }
  if (toolIndexes.length === 0) {
    return { messages, clearedToolCallIds: [], tokensFreed: 0 };
  }

  // Index of the first tool result that is old enough to compact.
  const cutoffIndex = toolIndexes[Math.max(0, toolIndexes.length - keepRecent)] ?? toolIndexes[0]!;
  const compactableIndexes = toolIndexes.filter((index) => index < cutoffIndex);

  let tokensFreed = 0;
  const clearedToolCallIds: string[] = [];
  const next = messages.slice();
  for (const index of compactableIndexes) {
    const message = messages[index]!;
    if (message.role !== "tool") continue;
    if (!exceedsToolResultBudget(message, budgetChars)) continue;
    const before = estimateTextTokens(toolResultText(message));
    const trimmed = clearToolResultContent(message, budgetChars);
    if (trimmed === message) continue;
    next[index] = trimmed;
    clearedToolCallIds.push(message.toolCallId);
    tokensFreed += Math.max(0, before - estimateTextTokens(toolResultText(trimmed)));
  }

  if (clearedToolCallIds.length === 0) {
    return { messages, clearedToolCallIds: [], tokensFreed: 0 };
  }
  return { messages: next, clearedToolCallIds, tokensFreed };
}
