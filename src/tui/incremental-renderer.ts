import type { WriteStream } from "node:tty";
import type { RenderLine } from "./render-lines.ts";

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
  const codes: number[] = [];
  if (line.bold) codes.push(1);
  if (line.dim) codes.push(2);
  if (line.strikethrough) codes.push(9);
  const color = line.tone === "success" ? 32 : line.tone === "running" ? 33 : line.tone === "error" || line.style === "error" ? 31 : line.style === "thinking" ? 35 : line.style === "tool" ? 36 : line.style === "todo" ? 33 : line.style === "muted" ? 90 : 37;
  codes.push(color);
  return `${indent}\x1b[${codes.join(";")}m${line.prefix ?? ""}${line.text}\x1b[0m`;
}

/** Create a stdout-compatible facade without mutating process.stdout. */
export function createIncrementalStdout(stdout: WriteStream): WriteStream {
  const renderer = new IncrementalTerminalRenderer(stdout);
  const facade = Object.create(stdout) as WriteStream & { write: WriteStream["write"] };
  facade.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    if (typeof chunk !== "string" || args.length > 0) {
      return stdout.write(chunk as string, ...(args as []));
    }
    renderer.write(chunk);
    return true;
  }) as WriteStream["write"];
  return facade;
}

function extractInkFrame(data: string): string | undefined {
  if (!data.includes("\n")) return undefined;
  const eraseIndex = data.lastIndexOf(ANSI_ERASE_LINE);
  if (eraseIndex >= 0) return data.slice(eraseIndex + ANSI_ERASE_LINE.length);
  if (data.includes(ANSI_CLEAR_TERMINAL)) {
    const home = data.lastIndexOf("\x1b[H");
    return home >= 0 ? data.slice(home + 3) : data.slice(data.indexOf(ANSI_CLEAR_TERMINAL) + ANSI_CLEAR_TERMINAL.length);
  }
  // The initial Ink frame has no erase prefix. The proxy is only installed
  // as Ink's stdout, so a newline-bearing write is a frame in this path.
  return data;
}
