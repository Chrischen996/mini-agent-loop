/** Recognize explicit provider policy codes, not arbitrary references to safety. */
const POLICY_CODE = /\b(sensitive_words_detected|content_filter|content_policy_violation)\b/i;

export function isContentPolicyError(error: unknown): boolean {
  return error instanceof LlmContentPolicyError || POLICY_CODE.test(
    error instanceof Error ? error.message : String(error),
  );
}

export class LlmContentPolicyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
  ) {
    super(
      `LLM content policy rejection (${code}; HTTP ${status}). ` +
      "The provider or gateway rejected the request under its content policy. " +
      "The response does not identify the triggering content; it may involve conversation history or tool output. " +
      "Automatic retry is disabled. Review the submitted context or contact the provider if this is a false positive." +
      (requestId ? ` Request ID: ${requestId}` : ""),
    );
    this.name = "LlmContentPolicyError";
  }
}

/** Keep legacy messages for ordinary HTTP failures; avoid echoing policy payloads. */
export function createLlmHttpError(status: number, statusText: string, rawText: string): Error {
  let code: string | undefined;
  let requestId: string | undefined;
  // Bound parsing and tolerate non-JSON gateway responses (including copied malformed JSON).
  const text = rawText.slice(0, 16_384);
  try {
    const payload = JSON.parse(text);
    const detail = payload?.error;
    for (const value of [detail?.code, detail?.type, detail?.message]) {
      if (typeof value === "string") {
        code ??= value.match(POLICY_CODE)?.[1]?.toLowerCase();
      }
    }
    const id = detail?.request_id ?? payload?.request_id;
    if (typeof id === "string" && /^[a-zA-Z0-9_.:-]{1,160}$/.test(id)) requestId = id;
  } catch {
    code = text.match(POLICY_CODE)?.[1]?.toLowerCase();
  }
  if (code) {
    requestId ??= text.match(/request[ _-]?id\s*:\s*([a-zA-Z0-9_.:-]{1,160})(?=[\s)"',}]|$)/i)?.[1];
    return new LlmContentPolicyError(status, code, requestId);
  }
  return new Error(`LLM HTTP ${status}: ${rawText.slice(0, 500) || statusText}`);
}
