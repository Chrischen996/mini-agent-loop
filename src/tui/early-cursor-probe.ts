/**
 * Module-level kick-off for the startup cursor probe.
 *
 * `queryCursorRow()` still has to be awaited before `render()` (a DSR callback
 * racing the first paint delays the frame by seconds), but nothing forces the
 * *query* itself to start that late. Evaluated first from `ink-main.tsx`, this
 * module issues `CSI 6 n` before ink/React/App are even parsed, so the terminal
 * round trip — or the full timeout on a terminal that never answers — overlaps
 * the module-graph load instead of being added to the first-frame path.
 *
 * Zero risk when it cannot help: without a TTY, in the alternate layout, under
 * the test runner, or with `MINI_AGENT_CURSOR_PROBE_MS=0` no probe is started
 * and the caller falls back to its own query (which no-ops in those cases).
 */
import {
  queryCursorRow,
  resolveCursorProbeTimeoutFromEnv,
  type CursorProbeResult,
} from "./cursor-probe.ts";
import { resolveTuiLayoutMode } from "./layout-mode.ts";

function startProbe(): Promise<CursorProbeResult> | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  // The test runner must never see raw-mode stdin or ESC[6n in its output.
  if (process.env.NODE_TEST_CONTEXT) return undefined;
  const layoutMode = resolveTuiLayoutMode();
  if (layoutMode === "alternate") return undefined;
  const timeoutMs = resolveCursorProbeTimeoutFromEnv();
  if (timeoutMs <= 0) return undefined;
  return queryCursorRow({
    stdin: process.stdin,
    stdout: process.stdout,
    layoutMode,
    timeoutMs,
  });
}

const earlyProbe = startProbe();

/**
 * Take the probe that was started at import time, if any.
 *
 * The promise is memoized, so repeated calls return the same in-flight query
 * and the DSR prompt is never written twice.
 */
export function takeEarlyCursorProbe(): Promise<CursorProbeResult> | undefined {
  return earlyProbe;
}
