import { PassThrough } from "node:stream";
import { TerminalInputFilter } from "./mouse-events.ts";

type RawModeStdin = NodeJS.ReadStream & {
  setRawMode(mode: boolean): unknown;
};

/**
 * Frame raw stdin for Ink so terminal control reports stay atomic.
 *
 * Raw-mode stdin delivers arbitrary byte chunks: a fast trackpad flick sends
 * several concatenated mouse reports in one read, and a busy event loop can
 * split one report across reads. Ink treats every `read()` as a single
 * keypress, so concatenated/split reports reached the prompt as text like
 * `[<64;20;8M`. This adapter classifies each chunk with the shared
 * `TerminalInputFilter` and re-emits every mouse report as its own read,
 * while plain text (UTF-8 keys, IME input, pastes) passes through unchanged.
 *
 * It is a real stream inserted between process.stdin and Ink; nothing is
 * monkeypatched, and raw-mode/ref lifecycle delegates to the source stream.
 */
export class TerminalStdinAdapter extends PassThrough {
  private readonly pendingQueue: string[] = [];
  private readonly classifier = new TerminalInputFilter();
  private readonly source: RawModeStdin;
  private disposed = false;

  constructor(source: RawModeStdin) {
    // objectMode keeps one write == one read. In byte mode PassThrough merges
    // consecutive writes, so Ink's `read()` loop would receive several mouse
    // reports as a single "keypress" again.
    super({ encoding: "utf8", objectMode: true });
    this.source = source;
    source.on("data", this.onData);
    // The adapter, not the source, feeds Ink; stop forwarding if the source
    // closes underneath us (Ctrl+D at an empty prompt).
    source.on("close", () => this.end());
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.disposed) return;
    const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const part of this.classifier.scan(data)) {
      // Forward the original bytes: mouse reports keep their coordinates and
      // stay one atomic read each, text passes through unchanged.
      if (part.raw) this.write(part.raw);
    }
  };

  get isTTY(): boolean {
    return true;
  }

  get isRaw(): boolean {
    return this.source.isRaw;
  }

  setRawMode(mode: boolean): this {
    this.source.setRawMode(mode);
    return this;
  }

  ref(): this {
    this.source.ref();
    return this;
  }

  unref(): this {
    this.source.unref();
    return this;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.source.removeListener("data", this.onData);
    this.end();
  }
}

/** Wrap a raw-mode stdin for Ink without monkeypatching the source stream. */
export function createTerminalStdin(source: RawModeStdin): NodeJS.ReadStream & TerminalStdinAdapter {
  return new TerminalStdinAdapter(source) as NodeJS.ReadStream & TerminalStdinAdapter;
}
