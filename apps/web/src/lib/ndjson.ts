export type NdjsonParserOptions = {
  /** Called for each line that fails to parse as JSON. */
  onParseError?: (line: string, error: unknown) => void;
};

/**
 * Incremental NDJSON parser (doc 1.md §7.1).
 *
 * A network chunk does NOT necessarily end on a JSON record boundary, so
 * records must be buffered and only complete lines emitted. This class is
 * pure (no DOM APIs) so it can be unit-tested under Node.
 */
export class NdjsonParser {
  private buffer = "";

  constructor(private readonly options: NdjsonParserOptions = {}) {}

  /** Feed one decoded chunk; returns every complete event it contains. */
  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const events: unknown[] = [];
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        const parsed = this.parseLine(line);
        if (parsed !== undefined) events.push(parsed);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
    return events;
  }

  /** Parse the trailing record when the stream ends without a final newline. */
  flush(): unknown[] {
    const line = this.buffer.trim();
    this.buffer = "";
    if (!line) return [];
    const parsed = this.parseLine(line);
    return parsed === undefined ? [] : [parsed];
  }

  private parseLine(line: string): unknown {
    try {
      return JSON.parse(line);
    } catch (error) {
      this.options.onParseError?.(line, error);
      return undefined;
    }
  }
}
