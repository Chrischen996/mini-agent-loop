/**
 * Render-loop observability for the terminal UI.
 *
 * The renderer reports every frame paint here; the monitor keeps slow-frame
 * counters (the Gemini CLI-style >200ms sentinel) plus a flicker detector that
 * flags physical rows repainted suspiciously often inside a one-second window
 * — the signature of layout thrash or diff regressions. Stats are cheap to
 * collect and stay in memory until queried or reported.
 */

export type RenderStats = {
  /** Total frames processed by the renderer. */
  frames: number;
  /** Total physical rows painted across all frames. */
  paintedRows: number;
  /** Frames whose paint took longer than the slow-frame threshold. */
  slowFrames: number;
  /** Duration of the slowest frame seen (ms). */
  maxFrameMs: number;
  /** Duration of the most recent frame (ms). */
  lastFrameMs: number;
  /** Sum of all frame durations — basis for averages. */
  totalFrameMs: number;
  /** How many distinct (row, window) pairs tripped the flicker threshold. */
  flickerSuspects: number;
  /** Duration of the most recent slow frame, when one has been seen. */
  lastSlowFrameMs?: number;
};

const DEFAULT_SLOW_FRAME_MS = 200;
const FLICKER_WINDOW_MS = 1000;
/** Repaints of one physical row inside a window before it counts as flicker. */
const FLICKER_REPAINT_THRESHOLD = 12;

type FlickerWindow = { startedAt: number; counts: Map<number, number> };

const stats: RenderStats = {
  frames: 0,
  paintedRows: 0,
  slowFrames: 0,
  maxFrameMs: 0,
  lastFrameMs: 0,
  totalFrameMs: 0,
  flickerSuspects: 0,
};

let slowFrameThresholdMs = DEFAULT_SLOW_FRAME_MS;
let flickerWindow: FlickerWindow = { startedAt: 0, counts: new Map() };

/** Override the slow-frame threshold (env `MINI_AGENT_SLOW_FRAME_MS`). */
export function setSlowFrameThreshold(ms: number): void {
  slowFrameThresholdMs = Math.max(1, ms);
}

export function getSlowFrameThreshold(): number {
  return slowFrameThresholdMs;
}

export function resolveSlowFrameThresholdFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number.parseFloat(env["MINI_AGENT_SLOW_FRAME_MS"] ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SLOW_FRAME_MS;
}

/** Record one frame paint. `nowMs` is injectable for deterministic tests. */
export function recordFramePaint(durationMs: number, paintedRows: number, nowMs = Date.now()): void {
  stats.frames += 1;
  stats.paintedRows += paintedRows;
  stats.lastFrameMs = durationMs;
  stats.totalFrameMs += durationMs;
  if (durationMs > stats.maxFrameMs) stats.maxFrameMs = durationMs;
  if (durationMs > slowFrameThresholdMs) {
    stats.slowFrames += 1;
    stats.lastSlowFrameMs = durationMs;
  }
  rotateFlickerWindow(nowMs);
}

/**
 * Record a repaint of one physical row. Windows rotate lazily on each record
 * or frame so idle sessions never hold stale counters.
 */
export function recordRowRepaint(row: number, nowMs = Date.now()): void {
  rotateFlickerWindow(nowMs);
  flickerWindow.counts.set(row, (flickerWindow.counts.get(row) ?? 0) + 1);
}

function rotateFlickerWindow(nowMs: number): void {
  if (flickerWindow.startedAt !== 0 && nowMs - flickerWindow.startedAt < FLICKER_WINDOW_MS) return;
  for (const count of flickerWindow.counts.values()) {
    if (count >= FLICKER_REPAINT_THRESHOLD) stats.flickerSuspects += 1;
  }
  flickerWindow = { startedAt: nowMs, counts: new Map() };
}

export function getRenderStats(): RenderStats {
  return { ...stats, lastSlowFrameMs: stats.lastSlowFrameMs };
}

export function resetRenderStats(): void {
  stats.frames = 0;
  stats.paintedRows = 0;
  stats.slowFrames = 0;
  stats.maxFrameMs = 0;
  stats.lastFrameMs = 0;
  stats.totalFrameMs = 0;
  stats.flickerSuspects = 0;
  stats.lastSlowFrameMs = undefined;
  flickerWindow = { startedAt: 0, counts: new Map() };
}

/** One-line human summary for diagnostics and exit reports. */
export function formatRenderReport(renderStats: RenderStats = getRenderStats()): string {
  const avg = renderStats.frames > 0 ? renderStats.totalFrameMs / renderStats.frames : 0;
  return [
    `frames=${renderStats.frames}`,
    `avg=${avg.toFixed(1)}ms`,
    `max=${renderStats.maxFrameMs.toFixed(1)}ms`,
    `slow(>${slowFrameThresholdMs}ms)=${renderStats.slowFrames}`,
    `rows=${renderStats.paintedRows}`,
    `flicker=${renderStats.flickerSuspects}`,
  ].join(" ");
}

/**
 * Install an at-exit summary on stderr when `MINI_AGENT_RENDER_STATS` is
 * enabled. Returns a disposer for tests and supervised relaunches.
 */
export function installRenderStatsReporting(
  env: Record<string, string | undefined> = process.env,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): () => void {
  if (env["MINI_AGENT_RENDER_STATS"] !== "1" && env["MINI_AGENT_RENDER_STATS"] !== "true") return () => {};
  const reporter = () => write(`[render-stats] ${formatRenderReport()}`);
  process.on("exit", reporter);
  return () => process.off("exit", reporter);
}
