import { readdir, stat } from "node:fs/promises";
import * as nodePath from "node:path";

/**
 * List candidates matching `fragment` inside `cwd`.
 * Returns paths relative to cwd, with directories suffixed by "/".
 *
 * - If fragment ends with "/" (e.g. "src/"), lists contents of that directory.
 * - If fragment contains "/" but no trailing slash (e.g. "src/tui/App"),
 *   recursively finds matching entries.
 * - If fragment has no "/", recursively searches for matches anywhere.
 */
export async function listCandidates(cwd: string, fragment: string): Promise<string[]> {
  try {
    // Trailing slash: list that directory's contents
    if (fragment.endsWith("/")) {
      const dir = fragment === "/" ? "" : fragment;
      const absDir = nodePath.join(cwd, dir || ".");
      return await listDirContents(absDir, dir, cwd);
    }

    const lastSlash = fragment.lastIndexOf("/");
    const dirPart = lastSlash >= 0 ? fragment.slice(0, lastSlash + 1) : "";
    const prefix = lastSlash >= 0 ? fragment.slice(lastSlash + 1) : fragment;

    // Has a parent directory part: list that dir (same as trailing-slash case)
    if (dirPart) {
      const absDir = nodePath.join(cwd, dirPart);
      return await listDirContents(absDir, dirPart, cwd, prefix);
    }

    // No slash at all: recursive search for prefix matches
    return await recursiveSearch(cwd, prefix, "", 0);
  } catch {
    return [];
  }
}

async function listDirContents(
  absDir: string,
  relDir: string,
  cwd: string,
  prefix?: string,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(absDir);
  } catch {
    return [];
  }
  const candidates: string[] = [];
  for (const entry of entries) {
    if (prefix && !entry.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    if (entry.startsWith(".") && !prefix?.startsWith(".")) continue;
    const rel = relDir + entry;
    try {
      const info = await stat(nodePath.join(cwd, rel));
      candidates.push(info.isDirectory() ? `${rel}/` : rel);
    } catch {
      candidates.push(rel);
    }
  }
  return candidates.slice(0, 20);
}

/**
 * Recursively search for entries matching `prefix`.
 * Stops descending into a directory once a file match is found (unless dirPrefixMatch).
 */
async function recursiveSearch(
  absDir: string,
  prefix: string,
  relSoFar: string,
  depth: number,
): Promise<string[]> {
  if (depth > 5) return []; // safety limit
  let entries: string[];
  try {
    entries = await readdir(absDir);
  } catch {
    return [];
  }
  const candidates: string[] = [];
  const dirs: { abs: string; rel: string; entry: string }[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".") && !prefix.startsWith(".")) continue;
    const rel = relSoFar ? `${relSoFar}/${entry}` : entry;
    const abs = nodePath.join(absDir, entry);
    try {
      const info = await stat(abs);
      if (info.isDirectory()) {
        if (entry.toLowerCase().startsWith(prefix.toLowerCase())) {
          candidates.push(`${rel}/`);
        }
        dirs.push({ abs, rel, entry });
      } else {
        if (entry.toLowerCase().startsWith(prefix.toLowerCase())) {
          candidates.push(rel);
        }
      }
    } catch {
      candidates.push(rel);
    }
  }
  // If we found matches at this level, don't recurse deeper
  if (candidates.length > 0) return candidates.slice(0, 20);
  // Recurse into ALL subdirs to find deeper matches
  for (const d of dirs) {
    const sub = await recursiveSearch(d.abs, prefix, d.rel, depth + 1);
    candidates.push(...sub);
  }
  return candidates.slice(0, 20);
}

interface _DirEntry { abs: string; rel: string; entry: string; }

/**
 * Extract all `@ref` tokens from input.
 * Matches @ followed by path chars containing at least one separator — avoids email addresses.
 */
export function parseAtRefs(input: string): string[] {
  const matches = input.match(/@([\w./\\-]+[\/\\][\w./\\-]*)/g);
  return matches ? matches.map((m) => m.slice(1)) : [];
}
