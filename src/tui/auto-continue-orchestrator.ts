/**
 * Auto-continue orchestrator for handling max_tokens truncation in TUI.
 * 
 * This module provides the logic to automatically retry with /continue
 * when LLM output is truncated.
 */

import type { AgentMessage } from "../types.ts";
import type { AutoContinueConfig } from "./auto-continue-config.ts";
import { shouldAutoContinue } from "./auto-continue-config.ts";
import { tuiContinuationPrompt, type TuiAgentTurnResult } from "./agent-turn.ts";
import type { AgentTurnOptions } from "../loop.ts";

export type AutoContinueContext = {
  config: AutoContinueConfig;
  attemptCount: number;
  onProgress?: (count: number, max: number) => void;
};

/**
 * Check if the turn result indicates a truncation that should trigger auto-continue.
 */
export function isTruncatedTurn(result: TuiAgentTurnResult, error?: Error): boolean {
  if (error) {
    return shouldAutoContinue(error, { enabled: true, maxAttempts: 0, delayMs: 0 }, 0);
  }
  
  // Check if stop reason indicates truncation
  if (result.stop?.reason === "step_limit") return false;
  
  const details = result.stop?.details ?? "";
  return /max_tokens|output reached|OutputTruncatedError/i.test(details);
}

/**
 * Execute auto-continue cycle with retry logic.
 * 
 * Returns the final history after all continuation attempts.
 */
export async function executeAutoContinue(
  initialHistory: AgentMessage[],
  runTurn: (history: AgentMessage[], prompt: string, options: AgentTurnOptions) => Promise<TuiAgentTurnResult>,
  turnOptions: AgentTurnOptions,
  context: AutoContinueContext,
): Promise<{ history: AgentMessage[]; truncated: boolean }> {
  let history = initialHistory;
  let attemptCount = context.attemptCount;
  const maxAttempts = context.config.maxAttempts;

  while (true) {
    attemptCount++;
    
    // Check if we've reached the limit
    if (maxAttempts > 0 && attemptCount > maxAttempts) {
      return { history, truncated: true };
    }

    // Notify progress
    context.onProgress?.(attemptCount, maxAttempts);

    // Delay before retry
    if (context.config.delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, context.config.delayMs));
    }

    // Execute continuation
    const continuePrompt = tuiContinuationPrompt(history);
    const result = await runTurn(history, continuePrompt, {
      ...turnOptions,
      isContinuation: true,
    });

    history = result.history;

    // Check if this turn was also truncated
    if (!isTruncatedTurn(result)) {
      // Success - no more truncation
      return { history, truncated: false };
    }

    // Still truncated, loop continues if under limit
  }
}
