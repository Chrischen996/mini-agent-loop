import type { WriteStream } from "node:tty";
import type { RenderLine } from "./render-lines.ts";
import { terminalStringWidth } from "./terminal-width.ts";
import { TUI_COLORS as C } from "./theme.ts";

const ANSI_ERASE_LINE = "\x1b[2K";
const ANSI_CLEAR_TERMINAL = "\x1b[2J";

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

function formatRenderLine(line: RenderLine): string {
  const indent = " ".repeat(Math.max(0, line.indent ?? 0));
  const codes: Array<number | string> = [];
  if (line.bold) codes.push(1);
  if (line.italic) codes.push(3);
  if (line.dim) codes.push(2);
  if (line.strikethrough) codes.push(9);
  const color = line.tone === "success" ? C.success
    : line.tone === "running" ? C.running
      : line.tone === "error" || line.style === "error" ? C.error
        : line.style === "thinking" ? C.thinking
          : line.style === "tool" ? C.info
            : line.style === "todo" ? C.info
              : line.style === "user" ? C.user
                : line.style === "border" || line.style === "muted" ? C.muted
                  : C.assistant;
  codes.push(hexToAnsi(color));
  if (line.background) {
    const background = line.background === "user" ? "48;5;236" : line.background === "selection" ? "48;5;24" : "48;5;178";
    codes.push(...background.split(";").map(Number));
  }
  const visible = `${line.prefix ?? ""}${line.text}`;
  const fill = line.fillWidth === undefined
    ? ""
    : " ".repeat(Math.max(0, line.fillWidth - terminalStringWidth(indent + visible)));
  return `${indent}\x1b[${codes.join(";")}m${visible}${fill}\x1b[0m`;
}

function hexToAnsi(hex: string): string {
  const value = hex.replace(/^#/, "");
  if (value.length !== 6) return "38;5;7";
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `38;2;${red};${green};${blue}`;
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
