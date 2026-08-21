import {
  calculateBackoff,
  classifyError,
  getRetryStrategy,
  type RetryableErrorType,
} from "./retry.ts";

export type RetryDecision = {
  errorType: Exclude<RetryableErrorType, "timeout" | "context_overflow">;
  attempt: number;
  maxRetries: number;
  delayMs: number;
};

/**
 * Keeps request-level retry counters outside the agent loop. Context overflow,
 * timeouts, and tool failures stay under the loop's explicit recovery rules.
 */
export class LlmRetryCoordinator {
  private readonly attempts = new Map<RetryableErrorType, number>();

  next(error: unknown): RetryDecision | undefined {
    const errorType = classifyError(error);
    if (!errorType || errorType === "timeout" || errorType === "context_overflow") {
      return undefined;
    }

    const strategy = getRetryStrategy(errorType);
    const attempt = (this.attempts.get(errorType) ?? 0) + 1;
    if (attempt > strategy.maxRetries) return undefined;

    this.attempts.set(errorType, attempt);
    return {
      errorType,
      attempt,
      maxRetries: strategy.maxRetries,
      delayMs: calculateBackoff(attempt, strategy),
    };
  }

  attemptsFor(errorType: RetryableErrorType): number {
    return this.attempts.get(errorType) ?? 0;
  }
}

export function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? abortError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}
