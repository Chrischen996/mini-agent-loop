/**
 * Cache bookkeeping for the `npm run tui` dev bundle.
 *
 * `node --import tsx` re-links and re-transpiles the whole TUI module graph on
 * every launch (~0.75 s of ESM linking before any module body runs), which is
 * what makes the terminal sit blank for about a second. The graph only changes
 * when a source file changes, so the launcher keeps one prebuilt bundle and
 * reuses it until this stamp moves.
 *
 * The stamp hashes the *content* of every bundlable file under `src/` (plus
 * package.json), so an edit, rename, add or delete always moves it — no mtime
 * heuristics to get wrong. It stays cheap (~10-20 ms for ~330 files / 2.7 MB)
 * because it runs once per `npm run tui`.
 */
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";

/** Bump when the bundle config or the stamp rules below change. */
export const DEV_BUNDLE_CACHE_VERSION = 1;

/** Extensions that can end up inside the bundle. */
const BUNDLED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"]);

export type DevBundlePaths = {
  /** `.cache/tui-dev` */
  cacheDir: string;
  /** `.cache/tui-dev/tui.js` — named `tui.js` on purpose: `ink-main.tsx` only
   * self-starts when `argv[1]` ends with `tui.js` or `ink-main.tsx`. */
  bundlePath: string;
  /** `.cache/tui-dev/meta.json` */
  metaPath: string;
  /** `.cache/tui-dev.tmp` — builds land here and are swapped in atomically. */
  stagingDir: string;
  /** `.cache/tui-dev.old` — previous build, kept only during the swap. */
  previousDir: string;
  /** `.cache/tui-dev.lock` — only one background build at a time. */
  lockPath: string;
};

export type DevBundleMeta = {
  version: number;
  fingerprint: string;
  builtAt: number;
};

export function resolveDevBundlePaths(repoRoot: string): DevBundlePaths {
  const cacheDir = path.join(repoRoot, ".cache", "tui-dev");
  return {
    cacheDir,
    bundlePath: path.join(cacheDir, "tui.js"),
    metaPath: path.join(cacheDir, "meta.json"),
    stagingDir: path.join(repoRoot, ".cache", "tui-dev.tmp"),
    previousDir: path.join(repoRoot, ".cache", "tui-dev.old"),
    lockPath: path.join(repoRoot, ".cache", "tui-dev.lock"),
  };
}

/**
 * Visit every bundlable file under `srcDir` in a stable order.
 *
 * Shared by the stamp and the fingerprint so both always describe the same set
 * of files.
 */
function forEachBundledFile(
  srcDir: string,
  visit: (relativePath: string, fullPath: string) => void,
): void {
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!BUNDLED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      visit(path.relative(srcDir, full), full);
    }
  };
  walk(srcDir);
}

/** One stamp row (`relativePath:size`) per bundlable file, sorted. */
export function collectSourceStamp(srcDir: string): string[] {
  const rows: string[] = [];
  forEachBundledFile(srcDir, (relativePath, fullPath) => {
    try {
      rows.push(`${relativePath}:${statSync(fullPath).size}`);
    } catch {
      // A file that vanished mid-walk also changes the stamp on the next run.
    }
  });
  return rows;
}

/**
 * Digest of everything that can change the bundle: the version tag, the `src/`
 * tree and any extra files (package.json) whose content the UI reads.
 */
export function computeSourceFingerprint(options: {
  srcDir: string;
  extraFiles?: string[];
  version?: number;
}): string {
  const version = options.version ?? DEV_BUNDLE_CACHE_VERSION;
  const hash = createHash("sha256");
  hash.update(`v${version}\n`);
  // One streaming digest instead of a hash object per file: ~330 reads is the
  // floor, the hashing itself costs single-digit milliseconds.
  forEachBundledFile(options.srcDir, (relativePath, fullPath) => {
    try {
      hash.update(`${relativePath}\n`);
      hash.update(readFileSync(fullPath));
      hash.update("\n");
    } catch {
      // Vanished mid-walk: the next run sees the new file set.
    }
  });
  for (const file of options.extraFiles ?? []) {
    let content = "";
    try {
      content = readFileSync(file, "utf8");
    } catch {
      content = "<missing>";
    }
    hash.update(`${path.basename(file)}\n${content.length}\n${content}\n`);
  }
  return hash.digest("hex");
}

export function readDevBundleMeta(metaPath: string): DevBundleMeta | undefined {
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as Partial<DevBundleMeta>;
    if (typeof parsed.fingerprint !== "string" || typeof parsed.version !== "number") return undefined;
    return {
      version: parsed.version,
      fingerprint: parsed.fingerprint,
      builtAt: typeof parsed.builtAt === "number" ? parsed.builtAt : 0,
    };
  } catch {
    return undefined;
  }
}

export function writeDevBundleMeta(metaPath: string, meta: DevBundleMeta): void {
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

/** A bundle is reusable only when it exists and was built from this exact stamp. */
export function isDevBundleFresh(
  paths: DevBundlePaths,
  meta: DevBundleMeta | undefined,
  fingerprint: string,
): boolean {
  if (!meta) return false;
  if (meta.version !== DEV_BUNDLE_CACHE_VERSION) return false;
  if (meta.fingerprint !== fingerprint) return false;
  try {
    return statSync(paths.bundlePath).size > 0;
  } catch {
    return false;
  }
}

/**
 * Take the build lock (`O_EXCL` create). A lock left behind by a killed build
 * is stolen once it is older than `staleMs`, so a crash can never wedge the
 * cache permanently.
 */
export function acquireBuildLock(lockPath: string, staleMs = 120_000, now = Date.now()): boolean {
  // The lock lives next to the cache, which may not exist on the very first run.
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    return false;
  }
  try {
    const fd = openSync(lockPath, "wx");
    writeSync(fd, `${JSON.stringify({ pid: process.pid, at: now })}\n`);
    closeSync(fd);
    return true;
  } catch {
    let ageMs = 0;
    try {
      ageMs = now - statSync(lockPath).mtimeMs;
    } catch {
      ageMs = 0;
    }
    if (ageMs < staleMs) return false;
    try {
      unlinkSync(lockPath);
    } catch {
      return false;
    }
    return acquireBuildLock(lockPath, staleMs, now);
  }
}

export function releaseBuildLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Already gone (stolen or never created) — nothing to do.
  }
}
