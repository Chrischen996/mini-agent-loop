import { NdjsonParser } from "./ndjson.ts";

/**
 * Consume an NDJSON response body (doc 1.md §7.1).
 *
 * Browser-only: relies on the fetch Response stream API. Aborting the
 * `signal` rejects with a DOMException("Aborted", "AbortError"), which is
 * also how callers distinguish "I stopped reading" from "the task errored".
 */
export async function readNdjson(
  response: Response,
  onEvent: (event: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("Response body is unavailable");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new NdjsonParser();

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const { value, done } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        onEvent(event);
      }
    }
    for (const event of parser.flush()) {
      onEvent(event);
    }
  } finally {
    reader.releaseLock();
  }
}
