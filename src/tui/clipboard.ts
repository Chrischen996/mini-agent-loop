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

function encodeOsc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
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
  // Emit the OSC 52 sequence and let the terminal perform the copy.
  try {
    const osc52 = encodeOsc52(text);
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

export function osc52Payload(text: string): string {
  return encodeOsc52(text);
}
