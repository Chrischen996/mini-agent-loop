import { readdir, realpath, stat } from "node:fs/promises";
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
  const target = trimmed === ""
    ? resolvedCwd
    : path.resolve(resolvedCwd, trimmed);

  if (!isPathInsideCwd(target, resolvedCwd)) {
    return {
      ok: false,
      error: `Path escapes workspace cwd: ${relativePath || "."}`,
    };
  }

  try {
    const realCwd = await realpath(resolvedCwd);
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

  const target = path.resolve(resolvedCwd, trimmed);
  if (!isPathInsideCwd(target, resolvedCwd)) {
    return {
      ok: false,
      error: `Path escapes workspace cwd: ${relativePath}`,
    };
  }

  const relativePosix = toPosixRelative(resolvedCwd, target);
  const segments = relativePosix.split("/").filter(Boolean);
  if (
    segments.some((segment) => segment === ".git" || segment === "node_modules")
  ) {
    return {
      ok: false,
      error: `Refusing to write under protected path: ${relativePosix}`,
    };
  }

  try {
    const realCwd = await realpath(resolvedCwd);

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
        if (!isPathInsideCwd(parent, resolvedCwd) && parent !== resolvedCwd) {
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
