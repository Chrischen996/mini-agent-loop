import type { WriteStream } from "node:tty";

/** Minimal stream surface used by the startup cursor probe. */
export type ProbeStdin = NodeJS.ReadStream & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
};

export type ProbeStdout = Pick<WriteStream, "isTTY" | "write">;

export type CursorProbeOptions = {
  stdin: ProbeStdin;
  stdout: ProbeStdout;
  layoutMode: "inline" | "alternate" | "document";
  timeoutMs?: number;
};

export type CursorProbeResult = {
  row?: number;
  /** Keystrokes that arrived with, or just before, the cursor report. */
  leftover: string;
};

/**
 * Locate the initial cursor row with DSR `CSI 6 n` before Ink renders its
 * first frame. Flow layouts use this row to anchor the frame instead of
 * stranding empty space between the shell prompt and the screen bottom.
 *
 * The probe temporarily owns stdin, so it restores the stream's previous
 * flowing/raw state on every exit path. Any bytes that are not part of the
 * cursor report are returned to the caller: they may be keystrokes the user
 * typed while the UI was still booting and must never be silently dropped.
 */
export async function queryCursorRow(options: CursorProbeOptions): Promise<CursorProbeResult> {
  const { stdin, stdout, layoutMode, timeoutMs = 300 } = options;
  const empty: CursorProbeResult = { leftover: "" };
  if (!stdin.isTTY || !stdout.isTTY || layoutMode === "alternate") return empty;

  // A paused source would keep TerminalStdinAdapter's `data` listener from
  // receiving any bytes after render. Remember the exact state we borrowed.
  const wasFlowing = stdin.isPaused() !== true;
  const wasRaw = stdin.isRaw === true;
  let pendingReport = "";
  let leftover = "";
  let settled = false;

  return await new Promise<CursorProbeResult>((resolve) => {
    const finish = (result: CursorProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      try {
        stdin.setRawMode?.(wasRaw);
      } catch {
        // Unsupported raw-mode streams simply stay as they are.
      }
      if (wasFlowing) stdin.resume();
      else stdin.pause();
      resolve(result);
    };

    // A split DSR report can leave a trailing ESC or `ESC[` prefix at the end
    // of a chunk. Keep that prefix buffered until the next read proves whether
    // it is a cursor report; release it as ordinary input on timeout.
    const holdPartialReportPrefix = (data: string): { buffer: string; leftover: string } => {
      // Only a suffix that could still grow into `ESC [ row ; col R` is held
      // across reads. Everything else is ordinary keystroke data.
      const suffix = /\x1b(?:\[(?:\d{0,4}(?:;\d{0,4})?)?)?$/.exec(data);
      if (!suffix) return { buffer: "", leftover: data };
      return {
        buffer: suffix[0],
        leftover: data.slice(0, data.length - suffix[0].length),
      };
    };

    /** Remove the first complete DSR report, keeping all other input bytes. */
    const takeCursorReport = (data: string): {
      row?: number;
      leftover: string;
      pending: string;
    } => {
      const match = /\x1b\[(\d{1,4});(\d{1,4})R/.exec(data);
      if (!match || match.index === undefined) {
        const held = holdPartialReportPrefix(data);
        return { leftover: held.leftover, pending: held.buffer };
      }
      const row = Number(match[1]) || undefined;
      return {
        row,
        leftover: data.slice(0, match.index) + data.slice(match.index + match[0].length),
        pending: "",
      };
    };

    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const parsed = takeCursorReport(pendingReport + text);
      pendingReport = parsed.pending;
      // Noise before the report is keystroke data. Return it immediately;
      // only a bounded partial DSR prefix remains pending.
      if (parsed.leftover) leftover += parsed.leftover;
      if (parsed.row !== undefined) {
        finish({ row: parsed.row, leftover });
      }
    };

    const timer = setTimeout(() => {
      finish({ leftover: leftover + pendingReport });
    }, timeoutMs);

    try {
      stdin.setRawMode?.(true);
      stdin.on("data", onData);
      stdin.resume();
      stdout.write("\x1b[6n");
    } catch {
      // A stream that cannot enter raw mode may still answer in cooked mode.
      try {
        stdin.on("data", onData);
        stdin.resume();
        stdout.write("\x1b[6n");
      } catch {
        finish({ leftover: leftover + pendingReport });
      }
    }
  });
}
