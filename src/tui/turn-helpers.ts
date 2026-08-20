import type { AgentMessage, MessageContent, ImagePart } from "../types.ts";
import type { Dispatch } from "react";
import type { TuiAction } from "./state.ts";
import { MaxTurnsExceededError } from "../loop.ts";
import { LlmTimeoutError } from "../llm/retry.ts";

/**
 * Extract display text for multi-line user input.
 */
export function buildDisplayText(
  planTurnOverride: { displayText: string; prompt: string } | null | undefined,
  normalizedPrompt: string,
): { displayText: string | undefined; lineCount: number; charCount: number } {
  if (planTurnOverride) {
    return { displayText: planTurnOverride.displayText, lineCount: 1, charCount: planTurnOverride.displayText.length };
  }
  const isMultiLine = normalizedPrompt.includes('\n');
  const lineCount = isMultiLine ? normalizedPrompt.split('\n').length : 1;
  const charCount = [...normalizedPrompt].length;
  return {
    displayText: isMultiLine ? `[已折叠 ${lineCount} 行 / ${charCount} 字]` : undefined,
    lineCount,
    charCount,
  };
}

/**
 * Build user content for agent turn (text + optional images).
 */
export function buildUserContent(
  planTurnOverride: { prompt: string } | null | undefined,
  prompt: string,
  resolvedText: string | MessageContent,
  imageParts: ImagePart[],
): MessageContent {
  const currentUserContent = planTurnOverride ? prompt : resolvedText;
  if (imageParts.length === 0) return currentUserContent;
  const contentParts = typeof currentUserContent === "string"
    ? [{ type: "text" as const, text: currentUserContent }]
    : currentUserContent;
  return [...contentParts, ...imageParts];
}

/**
 * Compute currentUserText (strips @mentions, normalizes whitespace).
 */
export function buildCurrentUserText(
  planTurnOverride: { prompt: string } | null | undefined,
  prompt: string,
): string {
  if (planTurnOverride) return prompt;
  return prompt.replace(/@\S+/g, "").replace(/\s{2,}/g, " ").trim();
}

/** Continuation info for auto-continue after MaxTurnsExceededError. */
export type ContinueInfo = {
  currentUserText: string;
  currentUserContent: string;
  autoContinueCount: number;
  maxAutoContinues: number;
  errorMessage: string | undefined;
  aborted: boolean;
};

/**
 * Handle MaxTurnsExceededError: update state and return continuation info.
 */
export function handleMaxTurnsExceeded(
  history: AgentMessage[],
  err: MaxTurnsExceededError,
  autoContinueCount: number,
  maxAutoContinues: number,
  signalAborted: boolean,
  abortPayload: { type: "aborted"; reason: "permission_mode_changed"; previousMode: string; permissionMode: string } | null,
  dispatch: Dispatch<TuiAction>,
): ContinueInfo | null {
  const newCount = autoContinueCount + 1;
  if (newCount >= maxAutoContinues || signalAborted) {
    const errorMessage = signalAborted ? "aborted" : `已达到自动续跑上限 (${maxAutoContinues} 次)`;
    if (signalAborted && abortPayload) {
      dispatch({ type: "LOOP_EVENT", event: { ...abortPayload, messages: history } } as any);
    } else if (signalAborted) {
      dispatch({ type: "LOOP_EVENT", event: { type: "aborted", messages: history } } as any);
    } else {
      dispatch({ type: "LOOP_EVENT", event: { type: "error", message: errorMessage } } as any);
    }
    return null;
  }
  return {
    currentUserText: "继续完成之前的工作",
    currentUserContent: "继续完成之前的工作",
    autoContinueCount: newCount,
    maxAutoContinues,
    errorMessage: undefined,
    aborted: false,
  };
}

/**
 * Handle LlmTimeoutError: save partial history and report.
 */
export function handleLlmTimeout(
  err: LlmTimeoutError,
  history: AgentMessage[],
  dispatch: Dispatch<TuiAction>,
): { errorMessage: string } | null {
  if (err.messages) {
    history.push(...err.messages);
    const errorMessage = `LLM timeout — partial response saved (${err.partialContent?.substring(0, 80) || ""})`;
    dispatch({ type: "LOOP_EVENT", event: { type: "error", message: errorMessage } } as any);
    return { errorMessage };
  }
  return null;
}

/**
 * Handle generic error: build abort or error event.
 */
export function handleTurnError(
  err: Error,
  signalAborted: boolean,
  abortPayload: { type: "aborted"; reason: "permission_mode_changed"; previousMode: string; permissionMode: string } | null,
  history: AgentMessage[],
  dispatch: Dispatch<TuiAction>,
): { errorMessage: string } | null {
  const turnErrorMessage = err instanceof Error ? err.message : String(err);
  if (signalAborted && abortPayload) {
    dispatch({ type: "LOOP_EVENT", event: { ...abortPayload, messages: history } } as any);
  } else if (signalAborted) {
    dispatch({ type: "LOOP_EVENT", event: { type: "aborted", messages: history } } as any);
  } else {
    dispatch({ type: "LOOP_EVENT", event: { type: "error", message: turnErrorMessage } } as any);
  }
  return { errorMessage: turnErrorMessage };
}
