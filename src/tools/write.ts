import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspaceWritePath } from "../workspace.ts";
import type { Tool, ToolResult } from "./types.ts";

export type WriteArgs = {
  path: string;
  /** Full UTF-8 file contents to write (create or overwrite). */
  content: string;
};

const MAX_WRITE_BYTES = 512 * 1024; // 512KB

export function createWriteTool(cwd: string): Tool<WriteArgs> {
  const resolvedCwd = path.resolve(cwd);

  return {
    name: "write",
    description:
      "Create or overwrite a UTF-8 text file in the workspace with the full file contents. Use relative paths. Prefer reading an existing file first before editing it. For modifications, write the complete updated file content.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to workspace cwd",
        },
        content: {
          type: "string",
          description: "Full UTF-8 contents to write to the file",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async execute(args: WriteArgs, signal?: AbortSignal): Promise<ToolResult> {
      if (signal?.aborted) {
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      }

      try {
        if (typeof args.path !== "string" || args.path.trim() === "") {
          return { content: "path must be a non-empty string", isError: true };
        }
        if (typeof args.content !== "string") {
          return { content: "content must be a string", isError: true };
        }

        const bytes = Buffer.byteLength(args.content, "utf8");
        if (bytes > MAX_WRITE_BYTES) {
          return {
            content: `content too large: ${bytes} bytes (max ${MAX_WRITE_BYTES})`,
            isError: true,
          };
        }

        const resolved = await resolveWorkspaceWritePath(resolvedCwd, args.path);
        if (!resolved.ok) {
          return { content: resolved.error, isError: true };
        }

        const parent = path.dirname(resolved.realTarget);
        await mkdir(parent, { recursive: true });
        if (signal?.aborted) {
          const err = new Error("Aborted");
          err.name = "AbortError";
          throw err;
        }
        await writeFile(resolved.realTarget, args.content, "utf8");

        const action = resolved.exists ? "Updated" : "Created";
        return {
          content: `${action} ${resolved.relative} (${bytes} bytes)`,
        };
      } catch (err) {
        if (
          err &&
          typeof err === "object" &&
          "name" in err &&
          (err as { name: unknown }).name === "AbortError"
        ) {
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: `Failed to write ${args.path}: ${message}`,
          isError: true,
        };
      }
    },
  };
}
