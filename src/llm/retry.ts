/**
 * Error classification, retry strategies, abort utilities, and unified LLM event contract.
 */
import type { AgentMessage, AssistantMessage } from "../types.ts";

// ─── Shared types ────────────────────────────────────────────────────────────

export type StreamChatUsage = {
  promptTokens: number;
  /** Tokens that were not served from cache (uncached input). */
  inputTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Tokens served from prompt cache (cache hit). */
  cacheReadTokens?: number;
  /** Tokens written to prompt cache (cache miss/write). */
  cacheWriteTokens?: number;
};

// ─── Legacy event type (kept for backward compat; loop now uses LlmStreamEvent) ───

export type StreamChatEvent =
  | { type: "text_delta"; text: string; kind: "reasoning" | "answer" }
  | { type: "assistant"; message: AssistantMessage; usage?: StreamChatUsage };

// ─── Unified LLM stream event contract ───────────────────────────────────────
// The LLM layer emits ONLY these events to the Agent Loop.
// The loop never inspects provider-specific response details.

export type ToolCallDelta = {
  index: number;
  id?: string;
  name?: string;
  argDelta?: string;
};

export type LlmStreamEvent =
  | { type: "reasoning_delta"; text: string }
  | { type: "answer_delta"; text: string }
  | { type: "tool_call_delta"; delta: ToolCallDelta }
  | { type: "completed"; message: AssistantMessage; usage?: StreamChatUsage }
  | { type: "error"; error: Error }
  | { type: "attempt_reset" }; // emitted before a recovery retry so the UI can clear temp reasoning

// ─── Typed incomplete-response errors ────────────────────────────────────────

export class IncompleteLlmResponseError extends Error {
  readonly reason: "reasoning_only" | "empty";
  constructor(reason: "reasoning_only" | "empty", message?: string) {
    super(message ?? `LLM incomplete response: ${reason}`);
    this.name = "IncompleteLlmResponseError";
    this.reason = reason;
  }
}

export class ThinkingCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThinkingCapabilityError";
  }
}

export class OutputTruncatedError extends Error {
  constructor() {
    super("LLM output reached max_tokens");
    this.name = "OutputTruncatedError";
  }
}

export class ProtocolError extends Error {
  constructor(msg: string) {
    super(`LLM protocol error: ${msg}`);
    this.name = "ProtocolError";
    this.msg = msg;
  }
  readonly msg: string;
}

/** Thrown when the LLM request times out. May contain partial content. */
export class LlmTimeoutError extends Error {
  readonly partialContent?: string;
  readonly messages?: AgentMessage[];

  constructor(partialContent?: string, messages?: AgentMessage[]) {
    super(`LLM request timed out after ${typeof process !== 'undefined' ? 'request timeout' : 'timeout'}`);
    this.name = "LlmTimeoutError";
    this.partialContent = partialContent;
    this.messages = messages;
  }
}

// ─── Context overflow ────────────────────────────────────────────────────────

export function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(context length|context window|maximum context|max context|too many tokens|prompt is too long|token limit|input.*token)/i.test(message);
}

// ─── Retry mechanism ─────────────────────────────────────────────────────────

export type RetryableErrorType =
  | "rate_limit"        // 429, rate limit exceeded
  | "server_overload"   // 503, 502, 504
  | "network"           // ECONNREFUSED, ETIMEDOUT, fetch failures
  | "timeout"           // request timeout (our internal timer)
  | "context_overflow"; // token limit (handled separately with compaction)

export type RetryStrategy = {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
};

/**
 * Classify an error to determine if and how it should be retried.
 * Returns null for non-retryable errors (auth, validation, etc).
 */
export function classifyError(error: unknown): RetryableErrorType | null {
  // Typed timeout errors take priority
  if (error instanceof LlmTimeoutError) return "timeout";
  
  const message = error instanceof Error ? error.message : String(error);

  // Rate limit (429 or explicit rate limit messages)
  if (/rate limit|429|too many requests|quota exceeded/i.test(message)) {
    return "rate_limit";
  }

  // Server overload / temporary unavailability
  if (/502|503|504|server (busy|overload|unavailable)|service unavailable/i.test(message)) {
    return "server_overload";
  }

  // Network failures
  if (/network error|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|ECONNRESET/i.test(message)) {
    return "network";
  }

  // Our internal timeout
  if (/timed out after.*ms/i.test(message)) {
    return "timeout";
  }

  // Context overflow (handled separately)
  if (isContextOverflowError(error)) {
    return "context_overflow";
  }

  return null;
}

/**
 * Get retry strategy for a specific error type.
 * Strategies use exponential backoff with jitter.
 */
export function getRetryStrategy(errorType: RetryableErrorType): RetryStrategy {
  switch (errorType) {
    case "rate_limit":
      return { maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 60000, backoffMultiplier: 3 };
    case "server_overload":
      return { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 10000, backoffMultiplier: 2 };
    case "network":
      return { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 5000, backoffMultiplier: 2 };
    case "timeout":
      return { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1 };
    case "context_overflow":
      return { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1 };
  }
}

/**
 * Calculate backoff delay with jitter for a given retry attempt.
 */
export function calculateBackoff(attempt: number, strategy: RetryStrategy): number {
  if (strategy.baseDelayMs === 0) return 0;
  const exponential = strategy.baseDelayMs * Math.pow(strategy.backoffMultiplier, attempt - 1);
  const capped = Math.min(exponential, strategy.maxDelayMs);
  const jitter = capped * (0.8 + Math.random() * 0.4);
  return Math.floor(jitter);
}

// ─── Abort utilities ─────────────────────────────────────────────────────────

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err ? String((err as { name: unknown }).name) : "";
  const message = err instanceof Error ? err.message : String(err);
  return name === "AbortError" || /aborted|AbortError/i.test(message);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const err = new Error("Aborted");
  err.name = "AbortError";
  throw err;
}
