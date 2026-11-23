import type { LlmTimeoutError } from "../llm/retry.ts";

/**
 * Human-readable message for an `LlmTimeoutError`, with a partial-response
 * preview. Shared by the Ink session view and the headless turn runner so both
 * surfaces report the same timeout text.
 */
export function formatLlmTimeoutMessage(err: LlmTimeoutError): string {
  const phaseLabel = err.phase === "first_response"
    ? "first response"
    : err.phase === "stream_idle"
      ? "stream idle"
      : err.phase === "total"
        ? "total request"
        : "request";
  const duration = err.timeoutMs !== undefined ? `, ${Math.ceil(err.timeoutMs / 1000)}s` : "";
  const preview = err.partialContent?.replace(/\s+/g, " ").trim().slice(0, 80);
  return preview
    ? `LLM timeout (${phaseLabel}${duration}) - partial response saved: ${preview}`
    : `LLM timeout (${phaseLabel}${duration}) - no partial response received`;
}
