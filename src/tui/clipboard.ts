import { runChildProcess } from "./child-process.ts";

export type ClipboardWriteResult = {
  ok: boolean;
  method: "pbcopy" | "wl-copy" | "xclip" | "clip" | "osc52" | "none";
  error?: string;
};

export type ClipboardIo = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  writeStdout?: (data: string) => boolean | void;
  run?: (command: string, args: string[], input: string) => Promise<void>;
};

const CLIPBOARD_TIMEOUT_MS = 5_000;

// xterm-compatible terminals cap each OSC 52 command parameter at 76 bytes;
// the base64 payload itself must fit in a single command.
const MAX_OSC52_BASE64_BYTES = 76;

function encodeOsc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

type NativeCandidate = {
  method: Exclude<ClipboardWriteResult["method"], "osc52" | "none">;
  command: string;
  args: string[];
};

function nativeCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): NativeCandidate[] {
  if (platform === "darwin") {
    return [{ method: "pbcopy", command: "pbcopy", args: [] }];
  }
  if (platform === "win32") {
    return [{ method: "clip", command: "clip", args: [] }];
  }
  const wayland = Boolean(env.WAYLAND_DISPLAY);
  const x11 = Boolean(env.DISPLAY);
  const linux: NativeCandidate[] = [];
  if (wayland || !x11) linux.push({ method: "wl-copy", command: "wl-copy", args: [] });
  if (x11 || !wayland) linux.push({ method: "xclip", command: "xclip", args: ["-selection", "clipboard"] });
  return linux;
}

// Fire-and-forget native clipboard fallback: try each backend in order and
// stop at the first success. Runs after an OSC 52 write so the clipboard is
// still filled when the terminal ignores or disables OSC 52 (e.g. Windows
// Terminal blocks OSC 52 writes by default).
async function runNativeSafetyNet(
  candidates: NativeCandidate[],
  text: string,
  run: (command: string, args: string[], input: string) => Promise<void>,
): Promise<void> {
  for (const candidate of candidates) {
    try {
      await run(candidate.command, candidate.args, text);
      return;
    } catch {
      /* Try the next backend. */
    }
  }
}

export async function writeClipboardText(
  text: string,
  io: ClipboardIo = {},
): Promise<ClipboardWriteResult> {
  if (!text) return { ok: false, method: "none", error: "Nothing to copy" };

  const platform = io.platform ?? process.platform;
  const env = io.env ?? process.env;
  const run = io.run ?? ((command: string, args: string[], input: string) => runChildProcess(command, args, {
    input,
    timeoutMs: CLIPBOARD_TIMEOUT_MS,
    stdio: ["pipe", "ignore", "pipe"],
  }));
  const writeStdout = io.writeStdout ?? ((data: string) => process.stdout.write(data));
  const candidates = nativeCandidates(platform, env);

  // ── Path 1: OSC 52 (preferred, ~0ms, handled by the terminal itself) ─────
  // Emit a single OSC 52 command whose base64 payload fits within the
  // terminal's per-command limit. Always fire-and-forget the native clipboard
  // tool as a safety net so the clipboard is still filled when the terminal
  // has OSC 52 writes disabled or ignored them.
  const base64 = Buffer.from(text, "utf8").toString("base64");
  if (base64.length <= MAX_OSC52_BASE64_BYTES) {
    try {
      writeStdout(`\x1b]52;c;${base64}\x07`);
      void runNativeSafetyNet(candidates, text, run).catch(() => {});
      return { ok: true, method: "osc52" };
    } catch {
      // Writing the OSC 52 sequence failed; fall through to native tools.
    }
  }
  // For larger payloads the base64 no longer fits a single command; use the
  // native tools below.

  // ── Path 2: native clipboard tools (safety net) ───────────────────────────
  for (const candidate of candidates) {
    try {
      await run(candidate.command, candidate.args, text);
      return { ok: true, method: candidate.method };
    } catch {
      /* Try the next backend. */
    }
  }

  return {
    ok: false,
    method: "none",
    error: "Every clipboard method failed",
  };
}

export function osc52Payload(text: string): string {
  return encodeOsc52(text);
}