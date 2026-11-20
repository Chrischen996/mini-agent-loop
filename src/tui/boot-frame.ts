/**
 * "Starting up" line for the window between process start and Ink's first frame.
 *
 * Even with the dev bundle cache, roughly half a second passes between the
 * launcher taking the terminal and Ink painting anything: node boot, then
 * evaluating ink + React (~370 ms measured) and the app graph. Until then the
 * terminal shows nothing at all, which reads as "the app hung".
 *
 * So the process that owns the terminal prints one line the moment it starts,
 * and the child erases exactly that line from inside `early-cursor-probe.ts` —
 * before the DSR query measures the screen, so the frame lands on the row the
 * boot line occupied and nothing is left behind in the transcript.
 *
 * Contract: the painter sets `MINI_AGENT_BOOT_FRAME=1` in the child's
 * environment *only* when it actually painted. The child erases one line only
 * when it sees that marker, then deletes it, so a RELAUNCH child (same
 * supervisor, second spawn) can never eat a real transcript line.
 *
 * Skipped when there is no TTY, under the test runner, in the alternate layout
 * (the alt-screen switch clears the screen by itself) and when
 * `MINI_AGENT_BOOT_FRAME=0`.
 */
export const BOOT_FRAME_ENV = "MINI_AGENT_BOOT_FRAME";

/** Reset attributes, jump to column 0, clear the line. */
const CLEAR_LINE = "\r\x1b[2K";
/** Move up one row (to the boot line), clear it, column 0. */
const ERASE_LINE_ABOVE = "\x1b[1A\x1b[2K\r";

const BOOT_FRAME_TEXT = "◇ mini-agent · 启动中…";

export type BootFrameStream = {
  isTTY?: boolean;
  write(chunk: string): unknown;
};

export type BootFrameEnv = Record<string, string | undefined>;

export type BootFrameOptions = {
  env: BootFrameEnv;
  stdout: BootFrameStream;
  /** Resolved `MINI_AGENT_TUI_LAYOUT`; `alternate` clears the screen itself. */
  layoutMode?: string;
};

export function shouldPaintBootFrame(options: BootFrameOptions): boolean {
  if (options.env[BOOT_FRAME_ENV] === "0") return false;
  if (!options.stdout.isTTY) return false;
  // The test runner must never see escape sequences in its output.
  if (options.env.NODE_TEST_CONTEXT) return false;
  return options.layoutMode !== "alternate";
}

/**
 * Print the boot line. Returns true when something was written — the caller
 * must then hand `MINI_AGENT_BOOT_FRAME=1` to the child it spawns.
 */
export function paintBootFrame(options: BootFrameOptions): boolean {
  if (!shouldPaintBootFrame(options)) return false;
  options.stdout.write(`${CLEAR_LINE}${BOOT_FRAME_TEXT}\n`);
  return true;
}

/**
 * Erase the boot line printed by the parent. No-op unless this process was
 * told one line was painted, and idempotent: the marker is deleted.
 */
export function clearBootFrame(options: Pick<BootFrameOptions, "env" | "stdout">): boolean {
  if (options.env[BOOT_FRAME_ENV] !== "1") return false;
  delete options.env[BOOT_FRAME_ENV];
  options.stdout.write(ERASE_LINE_ABOVE);
  return true;
}
