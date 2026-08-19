import { readdir, stat } from "node:fs/promises";
import * as nodePath from "node:path";

export async function listCandidates(cwd: string, fragment: string): Promise<string[]> {
  try {
    if (fragment.endsWith("/")) {
      const dir = fragment === "/" ? "" : fragment;
      const absDir = nodePath.join(cwd, dir || ".");
      return await listDirContents(absDir, dir, cwd);
    }

    const lastSlash = fragment.lastIndexOf("/");
    const dirPart = lastSlash >= 0 ? fragment.slice(0, lastSlash + 1) : "";
    const prefix = lastSlash >= 0 ? fragment.slice(lastSlash + 1) : fragment;

    if (dirPart) {
      const absDir = nodePath.join(cwd, dirPart);
      return await listDirContents(absDir, dirPart, cwd, prefix);
    }

    return await recursiveSearch(cwd, prefix, "", 0);
  } catch {
    return [];
  }
}

export async function listDirContents(
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

export async function recursiveSearch(
  absDir: string,
  prefix: string,
  relSoFar: string,
  depth: number,
): Promise<string[]> {
  if (depth > 5) return [];
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
  if (candidates.length > 0) return candidates.slice(0, 20);
  for (const d of dirs) {
    const sub = await recursiveSearch(d.abs, prefix, d.rel, depth + 1);
    candidates.push(...sub);
  }
  return candidates.slice(0, 20);
}
