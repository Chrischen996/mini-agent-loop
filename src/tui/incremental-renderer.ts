import type { WriteStream } from "node:tty";

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
    return true;
  }

  reset(): void {
    this.previousLines = undefined;
  }
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
