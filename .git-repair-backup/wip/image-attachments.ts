import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ImagePart } from "../types.ts";
import type { ImageAttachment } from "./state.ts";

export const MAX_TUI_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_TUI_IMAGES = 5;

type ClipboardImageOptions = {
  platform?: NodeJS.Platform;
  tempRoot?: string;
  runClipboardExport?: (outputPath: string) => Promise<void>;
  now?: () => number;
};

function sniffImageMime(buffer: Buffer): string | undefined {
  if (
    buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  const header = buffer.subarray(0, 6).toString("ascii");
  if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

function validateImageBuffer(buffer: Buffer, source: string): string {
  if (buffer.byteLength === 0) throw new Error(`${source} is empty`);
  if (buffer.byteLength > MAX_TUI_IMAGE_BYTES) {
    throw new Error(`${source} exceeds the 4MB image limit`);
  }
  const mimeType = sniffImageMime(buffer);
  if (!mimeType) {
    throw new Error(`${source} is not a supported PNG, JPEG, GIF, or WebP image`);
  }
  return mimeType;
}

function normalizePath(input: string, cwd: string): string {
  const trimmed = input.trim();
  const unquoted = (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) ? trimmed.slice(1, -1) : trimmed;
  if (unquoted === "~") return homedir();
  if (unquoted.startsWith("~/")) return resolve(homedir(), unquoted.slice(2));
  return resolve(cwd, unquoted);
}

export async function loadImageAttachment(
  inputPath: string,
  cwd = process.cwd(),
): Promise<ImageAttachment> {
  const filePath = normalizePath(inputPath, cwd);
  const buffer = await readFile(filePath);
  const mimeType = validateImageBuffer(buffer, filePath);
  return { path: filePath, mimeType, size: buffer.byteLength };
}

export async function imageAttachmentToPart(attachment: ImageAttachment): Promise<ImagePart> {
  const buffer = attachment.data
    ? Buffer.from(attachment.data, "base64")
    : await readFile(attachment.path);
  const mimeType = validateImageBuffer(buffer, attachment.path);
  return {
    type: "image",
    mimeType,
    data: buffer.toString("base64"),
    source: attachment.path,
  };
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function exportMacClipboardPng(outputPath: string): Promise<void> {
  const script = [
    "set pngData to (the clipboard as «class PNGf»)",
    `set outputFile to open for access POSIX file ${appleScriptString(outputPath)} with write permission`,
    "try",
    "set eof outputFile to 0",
    "write pngData to outputFile",
    "on error errorMessage number errorNumber",
    "try",
    "close access outputFile",
    "end try",
    "error errorMessage number errorNumber",
    "end try",
    "close access outputFile",
  ];

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("osascript", script.flatMap((line) => ["-e", line]), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("clipboard read timed out"));
    }, 5_000);

    child.stderr?.resume();
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error("clipboard does not contain a PNG-compatible image"));
    });
  });
}

export type WindowsClipboardCommand = {
  command: "powershell.exe";
  args: string[];
};

export function buildWindowsClipboardCommand(outputPath: string): WindowsClipboardCommand {
  const psScript = [
    "& {",
    "param([string]$OutputPath)",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$clip = [System.Windows.Forms.Clipboard]::GetImage()",
    "if ($clip -eq $null) { exit 1 }",
    "try { $clip.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $clip.Dispose() }",
    "}",
  ].join("\n");

  return {
    command: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-Command",
      psScript,
      outputPath,
    ],
  };
}

async function exportWindowsClipboardPng(outputPath: string): Promise<void> {
  const { command, args } = buildWindowsClipboardCommand(outputPath);

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("clipboard read timed out"));
    }, 5_000);

    child.stderr?.resume();
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error("clipboard does not contain an image"));
    });
  });
}

async function exportLinuxClipboardPng(outputPath: string): Promise<void> {
  const errors: string[] = [];

  // Try wl-paste first (Wayland)
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("wl-paste", ["--type", "image/png", "-o", outputPath], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`wl-paste failed with code ${code}`));
      });
    });
    return;
  } catch (err) {
    errors.push(`wl-paste: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Try xclip (X11)
  try {
    const tmpFile = outputPath + ".tmp";
    const xclipChild = spawn("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]);
    await new Promise<void>((resolve, reject) => {
      const writeStream = require("node:fs").createWriteStream(tmpFile);
      xclipChild.stdout?.pipe(writeStream);
      xclipChild.once("error", reject);
      writeStream.once("finish", resolve);
      writeStream.once("error", reject);
      xclipChild.once("close", (code) => {
        if (code !== 0) reject(new Error(`xclip failed with code ${code}`));
      });
    });
    await renameFile(tmpFile, outputPath);
    return;
  } catch (err) {
    errors.push(`xclip: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Try xsel (X11 fallback)
  try {
    const tmpFile = outputPath + ".tmp";
    const xselChild = spawn("xsel", ["--clipboard", "--output", "--target", "image/png"]);
    await new Promise<void>((resolve, reject) => {
      const writeStream = require("node:fs").createWriteStream(tmpFile);
      xselChild.stdout?.pipe(writeStream);
      xselChild.once("error", reject);
      writeStream.once("finish", resolve);
      writeStream.once("error", reject);
      xselChild.once("close", (code) => {
        if (code !== 0) reject(new Error(`xsel failed with code ${code}`));
      });
    });
    await renameFile(tmpFile, outputPath);
    return;
  } catch (err) {
    errors.push(`xsel: ${err instanceof Error ? err.message : String(err)}`);
  }

  throw new Error(`No clipboard tool available. Tried: ${errors.join(", ")}`);
}

async function renameFile(src: string, dest: string): Promise<void> {
  const { renameSync } = await import("node:fs");
  renameSync(src, dest);
}

export async function readClipboardImage(
  options: ClipboardImageOptions = {},
): Promise<ImageAttachment> {
  const platform = options.platform ?? process.platform;
  const tempDirectory = await mkdtemp(join(options.tempRoot ?? tmpdir(), "mini-agent-clipboard-"));
  const outputPath = join(tempDirectory, "clipboard.png");

  try {
    switch (platform) {
      case "darwin":
        await (options.runClipboardExport ?? exportMacClipboardPng)(outputPath);
        break;
      case "win32":
        await (options.runClipboardExport ?? exportWindowsClipboardPng)(outputPath);
        break;
      case "linux":
        await (options.runClipboardExport ?? exportLinuxClipboardPng)(outputPath);
        break;
      default:
        throw new Error(`clipboard image paste is not supported on ${platform}; use /image <path>`);
    }

    const buffer = await readFile(outputPath);
    const mimeType = validateImageBuffer(buffer, "clipboard image");
    const timestamp = (options.now ?? Date.now)();
    return {
      path: `clipboard-${timestamp}.${mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length)}`,
      mimeType,
      size: buffer.byteLength,
      data: buffer.toString("base64"),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`unable to read an image from the clipboard: ${detail}`);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}
