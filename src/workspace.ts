import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const MAX_DIR_ENTRIES = 500;

const IGNORED_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".DS_Store",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".mini-agent",
]);

export type WorkspaceEntry = {
  name: string;
  path: string;
  type: "file" | "dir";
};

export type ResolvedWorkspacePath =
  | {
      ok: true;
      target: string;
      realTarget: string;
      realCwd: string;
      relative: string;
    }
  | {
      ok: false;
      error: string;
      code?: string;
    };

export function isPathInsideCwd(resolvedPath: string, cwd: string): boolean {
  const relative = path.relative(cwd, resolvedPath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function isIgnoredName(name: string): boolean {
  return IGNORED_NAMES.has(name);
}

export function toPosixRelative(from: string, to: string): string {
  const relative = path.relative(from, to);
  if (!relative) return "";
  return relative.split(path.sep).join("/");
}

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    return String((err as { code: unknown }).code);
  }
  return undefined;
}

/**
 * Resolve a relative workspace path with symlink-escape protection.
 * Empty relativePath resolves to the workspace root.
 */
export async function resolveWorkspacePath(
  cwd: string,
  relativePath: string,
): Promise<ResolvedWorkspacePath> {
  const resolvedCwd = path.resolve(cwd);
  const trimmed = relativePath.trim();

  try {
    // Resolve the caller cwd first. This keeps relative paths consistent with
    // bash when the cwd itself is a symlink or the path contains `..`.
    const realCwd = await realpath(resolvedCwd);
    const target = trimmed === ""
      ? realCwd
      : path.isAbsolute(trimmed)
        ? path.resolve(trimmed)
        : path.resolve(realCwd, trimmed);
    if (!isPathInsideCwd(target, realCwd)) {
      return {
        ok: false,
        error: `Path escapes workspace cwd: ${relativePath || "."}`,
      };
    }
    const realTarget = await realpath(target);
    if (!isPathInsideCwd(realTarget, realCwd)) {
      return {
        ok: false,
        error: `Path resolves outside workspace cwd: ${relativePath || "."}`,
      };
    }
    return {
      ok: true,
      target,
      realTarget,
      realCwd,
      relative: toPosixRelative(realCwd, realTarget),
    };
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT") {
      return {
        ok: false,
        error: `Path not found: ${relativePath || "."}`,
        code,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Failed to resolve ${relativePath || "."}: ${message}`,
      code,
    };
  }
}

export async function listWorkspaceDirectory(
  cwd: string,
  relativePath = "",
): Promise<{
  path: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}> {
  const resolved = await resolveWorkspacePath(cwd, relativePath);
  if (!resolved.ok) {
    const error = new Error(resolved.error) as Error & {
      status?: number;
      code?: string;
    };
    error.status = resolved.code === "ENOENT" ? 404 : 400;
    error.code = resolved.code;
    throw error;
  }

  let info;
  try {
    info = await stat(resolved.realTarget);
  } catch (err) {
    const error = new Error(
      `Failed to stat ${relativePath || "."}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    ) as Error & { status?: number };
    error.status = 400;
    throw error;
  }

  if (!info.isDirectory()) {
    const error = new Error(
      `Path is not a directory: ${resolved.relative || "."}`,
    ) as Error & { status?: number };
    error.status = 400;
    throw error;
  }

  let names: string[];
  try {
    names = await readdir(resolved.realTarget);
  } catch (err) {
    const error = new Error(
      `Failed to list ${resolved.relative || "."}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    ) as Error & { status?: number };
    error.status = 400;
    throw error;
  }

  const entries: WorkspaceEntry[] = [];
  for (const name of names) {
    if (isIgnoredName(name)) continue;

    const childAbs = path.join(resolved.realTarget, name);
    try {
      const realChild = await realpath(childAbs);
      if (!isPathInsideCwd(realChild, resolved.realCwd)) continue;
      const childStat = await stat(realChild);
      const childType = childStat.isDirectory()
        ? "dir"
        : childStat.isFile()
        ? "file"
        : null;
      if (!childType) continue;

      const childRelative = resolved.relative
        ? `${resolved.relative}/${name}`
        : name;
      entries.push({
        name,
        path: childRelative.split(path.sep).join("/"),
        type: childType,
      });
    } catch {
      // Skip broken symlinks / unreadable entries.
    }
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const truncated = entries.length > MAX_DIR_ENTRIES;
  return {
    path: resolved.relative,
    entries: truncated ? entries.slice(0, MAX_DIR_ENTRIES) : entries,
    truncated,
  };
}

export const MAX_PREVIEW_BYTES = 512 * 1024;

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);

const BINARY_EXTENSIONS = new Set([
  "pdf", "zip", "gz", "tgz",
  "tar", "7z", "rar", "woff", "woff2", "ttf", "otf", "mp3", "mp4", "mov", "webm",
  "wasm", "exe", "dll", "so", "dylib", "bin", "lockb",
]);

export type WorkspaceFilePreview = {
  path: string;
  name: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  kind: "text" | "image";
  content: string;
  /** 1-based line number of the first returned line. */
  startLine: number;
  eof: boolean;
};

/** Read a workspace file for the web preview. Refuses escapes and binaries. */
export async function readWorkspaceFile(
  cwd: string,
  relativePath: string,
  options?: { offset?: number; limit?: number },
): Promise<WorkspaceFilePreview> {
  const resolved = await resolveWorkspacePath(cwd, relativePath);
  if (!resolved.ok) {
    const error = new Error(resolved.error) as Error & { status?: number; code?: string };
    error.status = resolved.code === "ENOENT" ? 404 : 400;
    error.code = resolved.code;
    throw error;
  }

  let info;
  try {
    info = await stat(resolved.realTarget);
  } catch (err) {
    const error = new Error(
      `Failed to stat ${relativePath || "."}: ${err instanceof Error ? err.message : String(err)}`,
    ) as Error & { status?: number };
    error.status = 400;
    throw error;
  }

  if (!info.isFile()) {
    const error = new Error(`Path is not a file: ${resolved.relative || "."}`) as Error & { status?: number };
    error.status = 400;
    throw error;
  }

  const name = path.basename(resolved.relative);
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (IMAGE_EXTENSIONS.has(ext)) {
    return {
      path: resolved.relative, name, size: info.size, truncated: false, binary: true,
      kind: "image", content: "", startLine: 1, eof: true,
    };
  }
  if (BINARY_EXTENSIONS.has(ext)) {
    return {
      path: resolved.relative, name, size: info.size, truncated: false, binary: true,
      kind: "text", content: "", startLine: 1, eof: true,
    };
  }

  const truncated = info.size > MAX_PREVIEW_BYTES;
  const handle = await open(resolved.realTarget, "r");
  try {
    const length = Math.min(info.size, MAX_PREVIEW_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    if (buffer.includes(0)) {
      return {
        path: resolved.relative, name, size: info.size, truncated: false, binary: true,
        kind: "text", content: "", startLine: 1, eof: true,
      };
    }
    const all = buffer.toString("utf8");
    const lines = all.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const total = Math.max(lines.length, 1);
    const offset = options?.offset !== undefined && Number.isFinite(options.offset)
      ? Math.max(1, Math.floor(options.offset))
      : 1;
    const limit = options?.limit !== undefined && Number.isFinite(options.limit)
      ? Math.max(1, Math.floor(options.limit))
      : undefined;
    // A capped read must not pretend lines past the buffer were loaded.
    const windowed = !truncated && (offset > 1 || limit !== undefined);
    const start = windowed ? Math.min(total, offset - 1) : 0;
    const end = windowed && limit !== undefined ? Math.min(total, start + limit) : total;
    const content = lines.slice(start, end).join("\n");
    return {
      path: resolved.relative,
      name,
      size: info.size,
      truncated,
      binary: false,
      kind: "text",
      content,
      startLine: start + 1,
      eof: !truncated && end >= total,
    };
  } finally {
    await handle.close();
  }
}

/** Validate referenced paths are files inside the workspace. */
export async function validateReferencedPaths(
  cwd: string,
  paths: string[],
): Promise<string[]> {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const raw of paths) {
    if (typeof raw !== "string" || raw.trim() === "") {
      const error = new Error(
        "referencedPaths entries must be non-empty strings",
      ) as Error & { status?: number };
      error.status = 400;
      throw error;
    }

    const resolved = await resolveWorkspacePath(cwd, raw);
    if (!resolved.ok) {
      const error = new Error(resolved.error) as Error & { status?: number };
      error.status = 400;
      throw error;
    }

    let info;
    try {
      info = await stat(resolved.realTarget);
    } catch {
      const error = new Error(`Referenced path not found: ${raw}`) as Error & {
        status?: number;
      };
      error.status = 400;
      throw error;
    }

    if (!info.isFile()) {
      const error = new Error(
        `Referenced path is not a file: ${resolved.relative || raw}`,
      ) as Error & { status?: number };
      error.status = 400;
      throw error;
    }

    if (!seen.has(resolved.relative)) {
      seen.add(resolved.relative);
      normalized.push(resolved.relative);
    }
  }

  return normalized;
}

/**
 * Resolve a workspace file path for writing.
 * Allows non-existent files when parents stay inside the workspace.
 * Existing directories are rejected.
 */
export async function resolveWorkspaceWritePath(
  cwd: string,
  relativePath: string,
): Promise<
  | {
      ok: true;
      target: string;
      realTarget: string;
      realCwd: string;
      relative: string;
      exists: boolean;
    }
  | {
      ok: false;
      error: string;
      code?: string;
    }
> {
  const resolvedCwd = path.resolve(cwd);
  const trimmed = relativePath.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed === "." || trimmed.endsWith("/")) {
    return {
      ok: false,
      error: "path must be a non-empty file path",
    };
  }

  try {
    const realCwd = await realpath(resolvedCwd);
    const target = path.isAbsolute(trimmed)
      ? path.resolve(trimmed)
      : path.resolve(realCwd, trimmed);
    if (!isPathInsideCwd(target, realCwd)) {
      return {
        ok: false,
        error: `Path escapes workspace cwd: ${relativePath}`,
      };
    }

    const relativePosix = toPosixRelative(realCwd, target);
    const segments = relativePosix.split("/").filter(Boolean);
    if (segments.some((segment) => segment === ".git" || segment === "node_modules")) {
      return {
        ok: false,
        error: `Refusing to write under protected path: ${relativePosix}`,
      };
    }

    try {
      const realTarget = await realpath(target);
      if (!isPathInsideCwd(realTarget, realCwd)) {
        return {
          ok: false,
          error: `Path resolves outside workspace cwd: ${relativePath}`,
        };
      }
      const info = await stat(realTarget);
      if (info.isDirectory()) {
        return {
          ok: false,
          error: `Path is a directory: ${relativePosix || relativePath}`,
        };
      }
      return {
        ok: true,
        target,
        realTarget,
        realCwd,
        relative: toPosixRelative(realCwd, realTarget),
        exists: true,
      };
    } catch (err) {
      if (errorCode(err) !== "ENOENT") {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: `Failed to resolve ${relativePath}: ${message}`,
          code: errorCode(err),
        };
      }
    }

    // New file: walk up to an existing ancestor and verify it stays inside cwd.
    let ancestor = path.dirname(target);
    while (true) {
      try {
        const realAncestor = await realpath(ancestor);
        if (!isPathInsideCwd(realAncestor, realCwd)) {
          return {
            ok: false,
            error: `Parent path resolves outside workspace cwd: ${relativePath}`,
          };
        }
        const rest = path.relative(ancestor, target);
        if (rest.startsWith("..") || path.isAbsolute(rest)) {
          return {
            ok: false,
            error: `Path escapes workspace cwd: ${relativePath}`,
          };
        }
        const realTarget = rest ? path.join(realAncestor, rest) : realAncestor;
        if (!isPathInsideCwd(realTarget, realCwd)) {
          return {
            ok: false,
            error: `Path escapes workspace cwd: ${relativePath}`,
          };
        }
        return {
          ok: true,
          target,
          realTarget,
          realCwd,
          relative: toPosixRelative(realCwd, realTarget),
          exists: false,
        };
      } catch (err) {
        if (errorCode(err) !== "ENOENT") {
          const message = err instanceof Error ? err.message : String(err);
          return {
            ok: false,
            error: `Failed to resolve parent for ${relativePath}: ${message}`,
            code: errorCode(err),
          };
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          return {
            ok: false,
            error: `Failed to resolve parent for ${relativePath}`,
          };
        }
        if (!isPathInsideCwd(parent, realCwd) && parent !== realCwd) {
          return {
            ok: false,
            error: `Path escapes workspace cwd: ${relativePath}`,
          };
        }
        ancestor = parent;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Failed to resolve ${relativePath}: ${message}`,
      code: errorCode(err),
    };
  }
}
