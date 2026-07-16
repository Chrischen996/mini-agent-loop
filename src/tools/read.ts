import { readFile } from "node:fs/promises";
import path from "node:path";
import { imagePart, textPart } from "../content.ts";
import { resolveWorkspacePath } from "../workspace.ts";
import type { Tool, ToolResult } from "./types.ts";

export type ReadArgs = {
  path: string;
  /** 1-based start line, optional */
  offset?: number;
  /** max lines, optional */
  limit?: number;
};

const MAX_BYTES = 100 * 1024; // 100KB text
const MAX_LINES = 2000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB

const IMAGE_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function applyLineWindow(
  text: string,
  offset?: number,
  limit?: number,
): { text: string; notice?: string } {
  const lines = text.split("\n");
  const start = offset !== undefined ? Math.max(0, offset - 1) : 0;

  if (start >= lines.length) {
    return {
      text: "",
      notice: `offset ${offset} is beyond end of file (${lines.length} lines)`,
    };
  }

  let end =
    limit !== undefined ? Math.min(lines.length, start + limit) : lines.length;
  let notice: string | undefined;

  if (end - start > MAX_LINES) {
    end = start + MAX_LINES;
    notice = `truncated to ${MAX_LINES} lines (file has ${lines.length} lines total)`;
  }

  const slice = lines.slice(start, end).join("\n");
  return { text: slice, notice };
}

function truncateByBytes(text: string): { text: string; notice?: string } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= MAX_BYTES) {
    return { text };
  }
  let end = MAX_BYTES;
  // Back up past an incomplete UTF-8 sequence before decoding. Buffer's
  // decoder otherwise inserts U+FFFD into the tool result.
  while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) end -= 1;
  if (end > 0 && (buf[end - 1]! & 0x80) !== 0) {
    const lead = buf[end - 1]!;
    const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (MAX_BYTES - (end - 1) < expected) end -= 1;
  }
  const sliced = buf.subarray(0, end).toString("utf8");
  return {
    text: sliced,
    notice: `truncated to ${MAX_BYTES} bytes (original ${buf.byteLength} bytes)`,
  };
}

function sniffImageMime(buf: Buffer): string | undefined {
  if (buf.length >= 8) {
    // PNG
    if (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    ) {
      return "image/png";
    }
    // JPEG
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return "image/jpeg";
    }
    // GIF
    if (
      buf[0] === 0x47 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x38
    ) {
      return "image/gif";
    }
    // WEBP: RIFF....WEBP
    if (
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf.length >= 12 &&
      buf[8] === 0x57 &&
      buf[9] === 0x45 &&
      buf[10] === 0x42 &&
      buf[11] === 0x50
    ) {
      return "image/webp";
    }
  }
  return undefined;
}

function mimeFromPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXT[ext];
}

export function createReadTool(cwd: string): Tool<ReadArgs> {
  const resolvedCwd = path.resolve(cwd);

  return {
    name: "read",
    description:
      "Read a workspace file by relative path. UTF-8 text supports optional offset/limit. Image files (png/jpeg/gif/webp) return image content for vision-capable models.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to workspace cwd",
        },
        offset: {
          type: "integer",
          minimum: 1,
          description: "1-based start line (optional, text only)",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Maximum number of lines to return (optional, text only)",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args: ReadArgs, signal?: AbortSignal): Promise<ToolResult> {
      if (signal?.aborted) {
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      }
      try {
        if (typeof args.path !== "string" || args.path.trim() === "") {
          return { content: "path must be a non-empty string", isError: true };
        }

        const resolved = await resolveWorkspacePath(resolvedCwd, args.path);
        if (!resolved.ok) {
          if (resolved.code === "ENOENT") {
            return { content: `File not found: ${args.path}`, isError: true };
          }
          return { content: resolved.error, isError: true };
        }

        let buf: Buffer;
        try {
          buf = await readFile(resolved.realTarget);
        } catch (err) {
          const code =
            err && typeof err === "object" && "code" in err
              ? String((err as { code: unknown }).code)
              : undefined;
          if (code === "ENOENT") {
            return { content: `File not found: ${args.path}`, isError: true };
          }
          if (code === "EISDIR") {
            return {
              content: `Path is a directory, not a file: ${args.path}`,
              isError: true,
            };
          }
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: `Failed to read ${args.path}: ${message}`,
            isError: true,
          };
        }

        const mime = mimeFromPath(resolved.target) ?? sniffImageMime(buf);
        if (mime) {
          if (buf.byteLength > MAX_IMAGE_BYTES) {
            return {
              content: `Image too large: ${args.path} is ${buf.byteLength} bytes (max ${MAX_IMAGE_BYTES})`,
              isError: true,
            };
          }
          const b64 = buf.toString("base64");
          return {
            content: [
              textPart(
                `Image file ${args.path} (${mime}, ${buf.byteLength} bytes).`,
              ),
              imagePart(mime, b64, args.path),
            ],
          };
        }

        // Text path
        const raw = buf.toString("utf8");
        // Heuristic: if many replacement chars / nulls, treat as binary
        if (raw.includes("\u0000")) {
          return {
            content: `Binary file (not a supported image): ${args.path} (${buf.byteLength} bytes)`,
            isError: true,
          };
        }

        const windowed = applyLineWindow(raw, args.offset, args.limit);
        const byted = truncateByBytes(windowed.text);
        const notices = [windowed.notice, byted.notice].filter(Boolean);

        if (notices.length === 0) {
          return { content: byted.text };
        }

        return {
          content: `${byted.text}\n\n[notice: ${notices.join("; ")}]`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: message, isError: true };
      }
    },
  };
}
