/**
 * Error classification, retry strategies, and abort utilities.
 */
import type { AssistantMessage } from "../types.ts";

// ─── Shared types ────────────────────────────────────────────────────────────

export type StreamChatUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type StreamChatEvent =
  | { type: "text_delta"; text: string; kind: "reasoning" | "answer" }
  | { type: "assistant"; message: AssistantMessage; usage?: StreamChatUsage };

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
      // Aggressive backoff for rate limits
      return { maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 60000, backoffMultiplier: 3 };
    case "server_overload":
      // Moderate backoff for server issues
      return { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 10000, backoffMultiplier: 2 };
    case "network":
      // Quick retry for network glitches
      return { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 5000, backoffMultiplier: 2 };
    case "timeout":
      // Single retry for timeouts (may need longer timeout instead)
      return { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1 };
    case "context_overflow":
      // No retry here; handled by compaction logic
      return { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1 };
  }
}

/**
 * Calculate backoff delay with jitter for a given retry attempt.
 * Jitter reduces thundering herd when many clients retry simultaneously.
 */
export function calculateBackoff(attempt: number, strategy: RetryStrategy): number {
  if (strategy.baseDelayMs === 0) return 0;
  const exponential = strategy.baseDelayMs * Math.pow(strategy.backoffMultiplier, attempt - 1);
  const capped = Math.min(exponential, strategy.maxDelayMs);
  // Add ±20% jitter
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
