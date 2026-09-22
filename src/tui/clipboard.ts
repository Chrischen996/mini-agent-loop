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

// Terminal ceilings for one OSC 52 sequence are large: kitty defaults to
// 512KB and iTerm2/alacritty/WezTerm/Windows Terminal accept well beyond
// 100KB. Cap the raw text at 75KB so the emitted sequence stays ~100KB,
// safely under every major terminal. (The old 76-byte cap was the MIME
// base64 line length mistakenly applied to OSC 52; it disabled clipboard
// copies over SSH for any reply longer than ~51 bytes, which is to say
// almost every assistant reply.)
const MAX_OSC52_TEXT_BYTES = 75_000;

function encodeOsc52(text: string, tmux = false): string {
  const sequence = `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
  if (!tmux) return sequence;
  // tmux swallows bare OSC 52 sequences coming from panes: wrap in a DCS
  // tmux passthrough, doubling every embedded ESC so tmux forwards the
  // inner sequence verbatim to the outer terminal.
  return `\x1bPtmux;${sequence.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
}

function nativeCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Array<{ method: Exclude<ClipboardWriteResult["method"], "osc52" | "none">; command: string; args: string[] }> {
  if (platform === "darwin") {
    return [{ method: "pbcopy", command: "pbcopy", args: [] }];
  }
  if (platform === "win32") {
    return [{ method: "clip", command: "clip", args: [] }];
  }
  const wayland = Boolean(env.WAYLAND_DISPLAY);
  const x11 = Boolean(env.DISPLAY);
  const linux: Array<{ method: "wl-copy" | "xclip"; command: string; args: string[] }> = [];
  if (wayland || !x11) linux.push({ method: "wl-copy", command: "wl-copy", args: [] });
  if (x11 || !wayland) linux.push({ method: "xclip", command: "xclip", args: ["-selection", "clipboard"] });
  return linux;
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

  // ── Path 1: OSC 52 (preferred, ~0ms, handled by the terminal itself) ─────
  // Emit the OSC 52 sequence and let the terminal perform the copy. Works
  // over SSH where no local clipboard helper exists, including tmux panes
  // via DCS passthrough.
  const tmux = Boolean(env.TMUX);
  try {
    const osc52 = encodeOsc52(text, tmux);
    // Base64 expands 4/3, so gating on the raw UTF-8 size keeps the whole
    // sequence within terminal limits.
    if (Buffer.byteLength(text, "utf8") <= MAX_OSC52_TEXT_BYTES) {
      writeStdout(osc52);
      // After OSC 52 succeeds, fire-and-forget a native tool as a safety net so
      // the clipboard is still filled when the terminal ignores OSC 52.
      if (platform !== "win32") {
        const candidates = nativeCandidates(platform, env);
        for (const candidate of candidates) {
          run(candidate.command, candidate.args, text).catch(() => {}); // fire-and-forget
          break; // only try the first available backend
        }
      }
      return { ok: true, method: "osc52" };
    }
    // For large text, fall through to native tools
  } catch (error) {
    // OSC 52 failed; fall back to the native tools.
  }

  // ── Path 2: native clipboard tools (safety net) ───────────────────────────
  for (const candidate of nativeCandidates(platform, env)) {
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

export function osc52Payload(text: string, tmux = false): string {
  return encodeOsc52(text, tmux);
}