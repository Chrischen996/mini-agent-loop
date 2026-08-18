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

function encodeOsc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
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
  if (!text) return { ok: false, method: "none", error: "没有可复制的内容" };

  const platform = io.platform ?? process.platform;
  const env = io.env ?? process.env;
  const run = io.run ?? runClipboardCommand;
  const writeStdout = io.writeStdout ?? ((data: string) => process.stdout.write(data));

  for (const candidate of nativeCandidates(platform, env)) {
    try {
      await run(candidate.command, candidate.args, text);
      return { ok: true, method: candidate.method };
    } catch {
      /* Try the next backend. */
    }
  }

  try {
    writeStdout(encodeOsc52(text));
    return { ok: true, method: "osc52" };
  } catch (error) {
    return {
      ok: false,
      method: "none",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function osc52Payload(text: string): string {
  return encodeOsc52(text);
}
