import { spawn } from "node:child_process";

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
const MAX_OSC52_BASE64_BYTES = 76;

type RunCommand = NonNullable<ClipboardIo["run"]>;
type NativeCandidate = {
  method: Exclude<ClipboardWriteResult["method"], "osc52" | "none">;
  command: string;
  args: string[];
};

function encodeOsc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

function osc52Supported(text: string): boolean {
  return Buffer.from(text, "utf8").toString("base64").length <= MAX_OSC52_BASE64_BYTES;
}

function writeOsc52(text: string, writeStdout: (data: string) => boolean | void): boolean {
  if (!osc52Supported(text)) return false;
  try {
    writeStdout(encodeOsc52(text));
    return true;
  } catch {
    return false;
  }
}

async function runClipboardCommand(command: string, args: string[], input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`${command} timed out`));
    }, CLIPBOARD_TIMEOUT_MS);

    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
    child.stdin?.once("error", () => {
      /* The child may exit before stdin finishes flushing. */
    });
    child.stdin?.end(input);
  });
}

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
  const linux: Array<{ method: "wl-copy" | "xclip"; command: string; args: string[] }> = [];
  if (wayland || !x11) linux.push({ method: "wl-copy", command: "wl-copy", args: [] });
  if (x11 || !wayland) linux.push({ method: "xclip", command: "xclip", args: ["-selection", "clipboard"] });
  return linux;
}

async function tryNativeCandidates(
  candidates: NativeCandidate[],
  text: string,
  run: RunCommand,
): Promise<Exclude<ClipboardWriteResult["method"], "osc52" | "none"> | undefined> {
  for (const candidate of candidates) {
    try {
      await run(candidate.command, candidate.args, text);
      return candidate.method;
    } catch {
      /* Try the next backend. */
    }
  }
  return undefined;
}

function startNativeSafetyNet(candidates: NativeCandidate[], text: string, run: RunCommand): void {
  let index = 0;
  const tryNext = () => {
    const candidate = candidates[index++];
    if (!candidate) return;
    void run(candidate.command, candidate.args, text).catch(tryNext);
  };
  tryNext();
}

export async function writeClipboardText(
  text: string,
  io: ClipboardIo = {},
): Promise<ClipboardWriteResult> {
  if (!text) return { ok: false, method: "none", error: "There is no content to copy" };

  const platform = io.platform ?? process.platform;
  const env = io.env ?? process.env;
  const run = io.run ?? runClipboardCommand;
  const writeStdout = io.writeStdout ?? ((data: string) => process.stdout.write(data));
  const candidates = nativeCandidates(platform, env);

  if (platform === "darwin") {
    const method = await tryNativeCandidates(candidates, text, run);
    if (method) return { ok: true, method };
  }

  const osc52Written = writeOsc52(text, writeStdout);
  if (osc52Written) {
    startNativeSafetyNet(candidates, text, run);
    await Promise.resolve();
    return { ok: true, method: "osc52" };
  }

  const method = await tryNativeCandidates(candidates, text, run);
  if (method) return { ok: true, method };

  return {
    ok: false,
    method: "none",
    error: "All clipboard methods failed",
  };
}

export function osc52Payload(text: string): string {
  return encodeOsc52(text);
}
