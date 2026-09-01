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
  if (!text) return { ok: false, method: "none", error: "没有可复制的内容" };

  const platform = io.platform ?? process.platform;
  const env = io.env ?? process.env;
  const run = io.run ?? ((command: string, args: string[], input: string) => runChildProcess(command, args, {
    input,
    timeoutMs: CLIPBOARD_TIMEOUT_MS,
    stdio: ["pipe", "ignore", "pipe"],
  }));
  const writeStdout = io.writeStdout ?? ((data: string) => process.stdout.write(data));

  // ── 第一路径：OSC 52（首选，~0ms，终端原生支持）──────────────────────────
  // 生成 OSC 52 序列并输出，让终端自行处理复制
  try {
    const osc52 = encodeOsc52(text);
    writeStdout(osc52);
    // OSC 52 成功后，fire-and-forget 原生工具作为安全网
    // 这样即使终端不支持 OSC 52，原生工具仍能写入剪贴板
    if (platform !== "win32") {
      const candidates = nativeCandidates(platform, env);
      for (const candidate of candidates) {
        run(candidate.command, candidate.args, text).catch(() => {}); // fire-and-forget
        break; // 只试第一个可用的
      }
    }
    return { ok: true, method: "osc52" };
  } catch (error) {
    // OSC 52 失败，回退到原生工具
  }

  // ── 第二路径：原生工具（安全网）────────────────────────────────────────────
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
    error: "所有复制方式均失败",
  };
}

export function osc52Payload(text: string): string {
  return encodeOsc52(text);
}
