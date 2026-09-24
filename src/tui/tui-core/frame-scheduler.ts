// tui-core — optional renderer-agnostic FrameScheduler for headless clients.
//
// Coalesces high-frequency store updates into at-most-one frame per 16ms.
// It owns *when* a frame is painted, not *what* is painted: consumers supply
// the render callback and can invalidate it from a store subscription.

export type FrameSchedulerOptions = {
  /** Target frame interval in ms. Default 16 (~60fps); the spinner
   * cadence (120ms) is a separate concern owned by the entrypoint. */
  intervalMs?: number;
  /**
   * When true, a call to `invalidate()` while a frame is already queued
   * is a no-op (coalesce). Default true — the point of the scheduler is
   * to collapse N store dispatches into one paint.
   */
  coalesce?: boolean;
};

export type FrameScheduler = {
  /**
   * Mark that a frame is dirty. Schedules exactly one `onFrame` call at
   * the next interval boundary (or immediately when no frame is pending
   * and `force` is true). Subsequent calls before the flush are
   * coalesced into that single flush.
   */
  invalidate(): void;
  /**
   * Force an immediate flush, even if a frame is already queued. Used
   * for resize / permission-gate / quit paths where the next interval
   * tick would be too late.
   */
  flushNow(): void;
  /** True when a frame has been invalidated but not yet painted. */
  isDirty(): boolean;
  /** Cancel any pending frame. Call on cleanup so a stray tick cannot
   * paint after the entrypoint has shut down. */
  dispose(): void;
};

export function createFrameScheduler(
  onFrame: () => void,
  options: FrameSchedulerOptions = {},
): FrameScheduler {
  const intervalMs = options.intervalMs ?? 16;
  const coalesce = options.coalesce ?? true;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const schedule = (): void => {
    if (disposed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (disposed) return;
      dirty = false;
      onFrame();
    }, intervalMs);
  };

  return {
    invalidate() {
      if (disposed) return;
      if (!coalesce && dirty) return;
      dirty = true;
      schedule();
    },
    flushNow() {
      if (disposed) return;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      dirty = false;
      onFrame();
    },
    isDirty() {
      return dirty;
    },
    dispose() {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      dirty = false;
    },
  };
}
