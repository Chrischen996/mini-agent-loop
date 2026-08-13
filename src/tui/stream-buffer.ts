import type { LoopEvent } from "../loop.ts";

type DeltaKind = "reasoning" | "answer";

type BufferedDelta = Extract<LoopEvent, { type: "assistant_delta" }>;

type EmitEvent = (event: LoopEvent) => void;

/** Keep streamed TUI updates below the terminal's redraw cadence. */
export const DEFAULT_STREAM_BUFFER_DELAY_MS = 80;

/**
 * Batches streamed deltas without allowing a completed turn to write into the
 * next turn. A run id also keeps late provider callbacks from reviving stale UI.
 */
export class TurnEventBuffer {
  private nextRunId = 0;
  private activeRunId: number | null = null;
  private pending: BufferedDelta[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly emit: EmitEvent, private readonly delayMs = DEFAULT_STREAM_BUFFER_DELAY_MS) {}

  start(): number {
    this.cancelTimer();
    this.pending = [];
    const runId = ++this.nextRunId;
    this.activeRunId = runId;
    return runId;
  }

  isActive(runId: number): boolean {
    return this.activeRunId === runId;
  }

  handle(runId: number, event: LoopEvent): boolean {
    if (!this.isActive(runId)) return false;

    if (event.type === "assistant_delta") {
      this.appendDelta(event);
      this.scheduleFlush(runId);
      return true;
    }

    this.flush(runId);
    if (!this.isActive(runId)) return false;
    this.emit(event);

    // max_turns is a continuation boundary, not a terminal event. The TUI
    // remains busy while App starts the next inner run.
    if (event.type === "done" || event.type === "aborted" || event.type === "error") {
      this.finish(runId);
    }
    return true;
  }

  /** Drop all buffered output and invalidate callbacks for this run. */
  finish(runId: number): void {
    if (!this.isActive(runId)) return;
    this.cancelTimer();
    this.pending = [];
    this.activeRunId = null;
  }

  /** Invalidate the active run, used by component cleanup. */
  dispose(): void {
    this.cancelTimer();
    this.pending = [];
    this.activeRunId = null;
  }

  private appendDelta(event: BufferedDelta): void {
    const previous = this.pending.at(-1);
    if (previous?.kind === event.kind) {
      previous.text += event.text;
      return;
    }
    this.pending.push({ type: "assistant_delta", text: event.text, kind: event.kind });
  }

  private scheduleFlush(runId: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush(runId);
    }, this.delayMs);
  }

  private flush(runId: number): void {
    if (!this.isActive(runId)) return;
    this.cancelTimer();
    const pending = this.pending;
    this.pending = [];
    for (const event of pending) this.emit(event);
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

export type { BufferedDelta, DeltaKind };
