/**
 * Test helper to safely mock globalThis.fetch with automatic restore.
 *
 * Replaces the repeated try/finally pattern across llm.test.ts, stream.test.ts,
 * and preprocessor.test.ts with a single utility.
 */

/**
 * Run `fn` with `globalThis.fetch` replaced by `handler`.
 * The original fetch is always restored, even if `fn` throws.
 */
export async function withMockFetch(
  handler: typeof fetch,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * A recording mock that captures every request and responds using a factory.
 * Useful when you need to assert on request details after the test runs.
 */
export function createRecordingFetch(
  respond: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>,
): {
  fetch: typeof fetch;
  requests: Array<{ url: string; init?: RequestInit }>;
} {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    requests.push({ url: String(input), init });
    return respond(input, init);
  };
  return { fetch: mockFetch as typeof fetch, requests };
}

/** Shortcut to create a JSON response object. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
