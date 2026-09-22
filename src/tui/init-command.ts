/**
 * /init command parser shared by both TUI clients and the CLI.
 *
 * Returns null for anything that is not an /init invocation so the caller
 * can fall through to the normal command pipeline. Unknown flags surface as
 * a structured error instead of being silently ignored.
 */

export type ParsedInitCommand = {
  kind: "ok";
  force: boolean;
  print: boolean;
} | {
  kind: "error";
  message: string;
};

export function parseInitCommand(input: string): ParsedInitCommand | null {
  const trimmed = input.trim();
  if (!/^\/init(?:\s+.*)?$/i.test(trimmed)) return null;

  const parts = trimmed.split(/\s+/).slice(1);
  let force = false;
  let print = false;

  for (const part of parts) {
    if (part === "--force" || part === "-f") {
      force = true;
    } else if (part === "--print" || part === "-p") {
      print = true;
    } else {
      return {
        kind: "error",
        message: `Unknown option "${part}". Usage: /init [--force] [--print]`,
      };
    }
  }

  return { kind: "ok", force, print };
}
