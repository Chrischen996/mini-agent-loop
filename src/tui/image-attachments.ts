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

export async function readClipboardImage(
  options: ClipboardImageOptions = {},
): Promise<ImageAttachment> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error("clipboard image paste is currently supported on macOS; use /image <path>");
  }

  const tempDirectory = await mkdtemp(join(options.tempRoot ?? tmpdir(), "mini-agent-clipboard-"));
  const outputPath = join(tempDirectory, "clipboard.png");
  try {
    await (options.runClipboardExport ?? exportMacClipboardPng)(outputPath);
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
