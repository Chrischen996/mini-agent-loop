import type { WriteStream } from "node:tty";
import type { RenderLine } from "./render-lines.ts";
import { formatRenderLine } from "./render-line-format.ts";

const ANSI_ERASE_LINE = "\x1b[2K";
const ANSI_CLEAR_TERMINAL = "\x1b[2J";
const ANSI_CURSOR_SHOW = "\x1b[?25h";

export type TerminalDisplayMode = "pi" | "scrollback" | "fullscreen";

/** Terminal capabilities that influence the default presentation mode. */
export type TerminalDisplayCapabilities = {
  /** True when both stdin and stdout are attached to an interactive TTY. */
  interactive: boolean;
};

function currentTerminalCapabilities(): TerminalDisplayCapabilities {
  return { interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) };
}

/**
 * Resolve the standalone terminal presentation mode.
 *
 * pi-tui alternate-screen rendering is the default because it can reflow
 * already-rendered history when a reasoning block is expanded. Scrollback and
 * the previous fixed viewport remain explicit compatibility modes.
 *
 * `capabilities` is injectable so the resolution stays a pure function of its
 * inputs: passing an explicit `env` previously still read ambient
 * `process.stdin.isTTY`, which made the result depend on how the process was
 * launched.
 */
export function resolveTerminalDisplayMode(
  env: NodeJS.ProcessEnv = process.env,
  capabilities: TerminalDisplayCapabilities = currentTerminalCapabilities(),
): TerminalDisplayMode {
  const mode = env.MINI_AGENT_TUI_MODE?.trim().toLowerCase();
  if (mode === "pi" || mode === "component" || mode === "alternate") return "pi";
  if (mode === "fullscreen" || mode === "full") return "fullscreen";
  if (mode === "scrollback" || mode === "main" || mode === "main-screen") return "scrollback";

  const fullscreen = env.MINI_AGENT_TUI_FULLSCREEN?.trim().toLowerCase();
  if (fullscreen === "1" || fullscreen === "true" || fullscreen === "yes") return "fullscreen";
  const scrollback = env.MINI_AGENT_TUI_SCROLLBACK?.trim().toLowerCase();
  if (scrollback === "1" || scrollback === "true" || scrollback === "yes") return "scrollback";
  if (scrollback === "0" || scrollback === "false" || scrollback === "no") return "fullscreen";
  // In VS Code sandbox / non-interactive terminals, default to scrollback
  // to avoid pi-tui alternate-screen redraw overhead.
  if (!capabilities.interactive) return "scrollback";
  return "pi";
}

/**
 * Adapts Ink's full-frame log-update writes to row-level terminal updates.
 * Ink remains responsible for layout and input; this boundary only changes
 * how completed frames reach the terminal.
 */
export class IncrementalTerminalRenderer {
  private previousLines: string[] | undefined;

  constructor(private readonly target: WriteStream) {}

  write(data: string): boolean {
    const frame = extractInkFrame(data);
    if (frame === undefined) {
      this.target.write(data);
      return true;
    }

    const nextLines = frame.split("\n");
    if (nextLines.at(-1) === "") nextLines.pop();
    this.renderLines(nextLines.map((text, index) => ({ key: `ink-${index}`, text, style: "assistant" as const })));
    return true;
  }

  /** Direct entrypoint for presentation models that no longer need Ink. */
  renderLines(lines: readonly RenderLine[]): void {
    this.renderRows(lines.map(formatRenderLine));
  }

  private renderRows(nextLines: string[]): void {
    const previous = this.previousLines ?? [];
    let output = "";

    for (let index = 0; index < nextLines.length; index++) {
      if (nextLines[index] === previous[index]) continue;
      output += `\x1b[${index + 1};1H${ANSI_ERASE_LINE}${nextLines[index] ?? ""}`;
    }
    for (let index = nextLines.length; index < previous.length; index++) {
      output += `\x1b[${index + 1};1H${ANSI_ERASE_LINE}`;
    }

    if (output) {
      // Leave the cursor where Ink expects it after a frame write.
      output += `\x1b[${Math.max(1, nextLines.length)};1H`;
      this.target.write(output);
    }
    this.previousLines = nextLines;
  }

  reset(): void {
    this.previousLines = undefined;
  }
}

/**
 * Renderer for Claude Code's main-screen transcript mode.
 *
 * Completed rows are written once and become ordinary terminal scrollback.
 * Only the suffix marked `ephemeral` is moved back and redrawn on subsequent
 * frames. This keeps streaming text, spinners, overlays, and the prompt live
 * without putting the entire conversation inside an alternate-screen frame.
 */
export class ScrollbackTerminalRenderer {
  private committedRows: string[] = [];
  private liveRows: string[] = [];
  private started = false;

  constructor(private readonly target: Pick<WriteStream, "write">) {}

  renderLines(lines: readonly RenderLine[]): void {
    const formatted = lines.map(formatRenderLine);
    const firstLiveIndex = lines.findIndex((line) => line.ephemeral === true);
    const nextCommitted = firstLiveIndex < 0 ? formatted : formatted.slice(0, firstLiveIndex);
    const nextLive = firstLiveIndex < 0 ? [] : formatted.slice(firstLiveIndex);

    if (!this.started) {
      this.target.write(formatted.map((line) => `${line}\n`).join(""));
      this.committedRows = nextCommitted;
      this.liveRows = nextLive;
      this.started = true;
      return;
    }

    let output = "";
    const oldLiveCount = this.liveRows.length;
    const stableChanged = !sameRows(this.committedRows, nextCommitted);
    if (!stableChanged && sameRows(this.liveRows, nextLive)) return;

    if (oldLiveCount > 0) {
      // The cursor is left immediately after the old live tail. Clear that
      // tail in place before appending any newly committed transcript rows.
      // A changed committed prefix starts after the erased tail; otherwise
      // the replacement live tail starts at the same first row.
      output += this.eraseLiveRows(stableChanged ? "after" : "start");
    }

    if (stableChanged) {
      let appendRows: string[];
      if (isPrefix(this.committedRows, nextCommitted)) {
        appendRows = nextCommitted.slice(this.committedRows.length);
      } else {
        // A reset, width change, or historical toggle cannot rewrite rows
        // already in terminal scrollback. Start a new visual segment instead.
        output += "\n";
        appendRows = nextCommitted;
      }
      for (const row of appendRows) output += `${row}\n`;
    }

    for (const row of nextLive) output += `${ANSI_ERASE_LINE}${row}\n`;
    if (output) this.target.write(output);
    this.committedRows = nextCommitted;
    this.liveRows = nextLive;
  }

  /**
   * Force the next render to treat all committed content as new, without
   * attempting incremental prefix-based diffing. Call after a session restore
   * or other major content replacement to avoid stale row comparisons.
   */
  forceNewSegment(): void {
    this.committedRows = [];
  }

  /** Leave the committed transcript in scrollback and return control to the shell. */
  finish(): void {
    if (!this.started) return;
    // Ephemeral rows are a live editing surface, not part of the transcript.
    // Remove them before handing the cursor back to the shell so an input
    // prompt, spinner, or permission card cannot remain as stale output.
    const output = this.eraseLiveRows("start");
    this.target.write(`${output}${ANSI_CURSOR_SHOW}`);
    this.liveRows = [];
    this.started = false;
  }

  reset(): void {
    this.committedRows = [];
    this.liveRows = [];
    this.started = false;
  }

  private eraseLiveRows(position: "start" | "after"): string {
    const count = this.liveRows.length;
    if (count === 0) return "";

    let output = `\x1b[${count}A`;
    for (let index = 0; index < count; index++) {
      output += `\r${ANSI_ERASE_LINE}`;
      if (index < count - 1) output += "\n";
    }
    if (position === "start" && count > 1) {
      // Clearing stops on the last old row; return to the first row so the
      // replacement live tail or shell prompt starts at its original position.
      output += `\x1b[${count - 1}A`;
    } else if (position === "after") {
      // A newline here is safe even when the cursor is at the bottom: terminal
      // scrollback absorbs the movement and keeps the transcript append-only.
      output += "\n";
    }
    return output;
  }
}

function sameRows(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((row, index) => row === right[index]);
}

function isPrefix(prefix: readonly string[], value: readonly string[]): boolean {
  return prefix.length <= value.length && prefix.every((row, index) => row === value[index]);
}

/** Create a stdout-compatible facade without mutating process.stdout. */
export function createIncrementalStdout(stdout: WriteStream): WriteStream {
  const renderer = new IncrementalTerminalRenderer(stdout);
  // A proxy keeps rows/columns, isTTY, resize listeners, and stream internals
  // from the real WriteStream. Object.create(stdout) loses own properties such
  // as `rows`, which makes Ink believe the terminal has zero height.
  return new Proxy(stdout, {
    get(target, property, receiver) {
      if (property === "write") {
        return ((chunk: string | Uint8Array, ...args: unknown[]) => {
          if (typeof chunk !== "string" || args.length > 0) {
            return target.write(chunk as string, ...(args as []));
          }
          renderer.write(chunk);
          return true;
        }) as WriteStream["write"];
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function extractInkFrame(data: string): string | undefined {
  if (data.includes(ANSI_CLEAR_TERMINAL)) {
    const home = data.lastIndexOf("\x1b[H");
    return home >= 0 ? data.slice(home + 3) : data.slice(data.indexOf(ANSI_CLEAR_TERMINAL) + ANSI_CLEAR_TERMINAL.length);
  }
  // log-update.eraseLines() ends with `ESC[G`; remove the whole cursor/erase
  // prefix rather than treating that cursor command as visible frame text.
  const cursorHome = data.lastIndexOf("\x1b[G");
  if (cursorHome >= 0) return data.slice(cursorHome + 3);
  if (!data.includes("\n")) return undefined;
  // The initial Ink frame has no erase prefix. The proxy is only installed
  // as Ink's stdout, so a newline-bearing write is a frame in this path.
  return data;
}
