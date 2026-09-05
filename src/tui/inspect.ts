/**
 * Parsing for the TUI's `--inspect` / `--inspect-brk` debugger flags.
 *
 * Kept separate from the Ink entrypoint so the flag semantics are unit
 * testable without booting a terminal UI.
 */

export const DEFAULT_INSPECT_PORT = 9229;

export type InspectOptions = {
  enabled: true;
  /** True when the process should pause on the first line (`--inspect-brk`). */
  breakOnStart: boolean;
  port: number;
};

function parsePort(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid inspector port for ${flag}: ${JSON.stringify(raw)}`);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid inspector port for ${flag}: ${JSON.stringify(raw)}`);
  }
  return port;
}

/**
 * Returns inspector options for the first recognised inspect flag in `argv`,
 * or `null` when none is present. Only the exact flags `--inspect` and
 * `--inspect-brk` (optionally with `=<port>`) are recognised, so unrelated
 * flags such as `--inspection` are ignored.
 *
 * Throws when a recognised flag carries a malformed or out-of-range port.
 */
export function parseInspectArgs(argv: readonly string[]): InspectOptions | null {
  for (const arg of argv) {
    const match = /^--inspect(-brk)?(?:=(.*))?$/.exec(arg);
    if (!match) continue;
    const breakOnStart = match[1] === "-brk";
    const flag = breakOnStart ? "--inspect-brk" : "--inspect";
    const port = match[2] === undefined ? DEFAULT_INSPECT_PORT : parsePort(match[2], flag);
    return { enabled: true, breakOnStart, port };
  }
  return null;
}

/**
 * Opens the Node inspector when an inspect flag is present. Returns the
 * resolved options so callers can log or surface the debugger endpoint.
 */
export async function openInspectorFromArgs(
  argv: readonly string[],
  host = "127.0.0.1",
): Promise<InspectOptions | null> {
  const options = parseInspectArgs(argv);
  if (!options) return null;
  const inspector = await import("node:inspector");
  inspector.open(options.port, host, options.breakOnStart);
  return options;
}
