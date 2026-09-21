/**
 * Non-blocking update check for the published CLI/TUI.
 *
 * Design goals:
 * - Never delay or break startup: every path degrades to `null` (no update,
 *   offline, or disabled).
 * - Throttled: at most one registry round-trip per 24h per install; the
 *   result is cached in the agent data dir so repeat runs are instant.
 * - Explicit opt-out via MINI_AGENT_UPDATE_CHECK=0/false/off.
 *
 * The installed version is resolved by walking up from the entry file to the
 * nearest package.json, which works for both the bundled dist/*.js entries
 * and dev runs from src/.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDataRoot } from "./session-store.ts";

const PACKAGE_NAME = "@krischen99999/mini-agent-loop";
const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}@latest`;
export const UPDATE_CHECK_CACHE_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 4000;
const CACHE_FILE = "update-check.json";
/** The shell command the user runs to self-upgrade the global install. */
export const UPGRADE_COMMAND = `npm install -g ${PACKAGE_NAME}`;

export interface UpdateInfo {
  /** The published version on the registry. */
  latest: string;
  /** The locally installed version. */
  current: string;
  /** True only when `latest` is a strictly newer semver. */
  isUpgrade: boolean;
}

export interface UpdateCheckOptions {
  /** Force a fresh registry lookup, ignoring the 24h cache. */
  force?: boolean;
  /** Test override: registry "latest" lookup result. */
  fetchLatest?: () => Promise<string | null>;
  /** Test override: installed version. */
  currentVersion?: string;
  /** Test override: cache file path. */
  cacheFile?: string;
  /** Test override: clock. */
  now?: () => number;
  /** Test override: disable detection. */
  enabled?: boolean;
}

function isDisabled(): boolean {
  const value = process.env.MINI_AGENT_UPDATE_CHECK;
  if (value === undefined) return false;
  return ["0", "false", "off"].includes(value.toLowerCase());
}

/** Walk up from the given module file to the nearest package.json version. */
export async function resolveInstalledVersion(entryFile?: string): Promise<string | null> {
  const start = entryFile
    ? dirname(entryFile)
    : dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (let i = 0; i < 12; i += 1) {
    const candidate = join(dir, "package.json");
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
      // Match only this package's manifest, not some transitive workspace.
      if (parsed.name === PACKAGE_NAME && typeof parsed.version === "string") {
        return parsed.version;
      }
      if (typeof parsed.version === "string") return parsed.version;
    } catch {
      // Keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

interface CacheEntry {
  checkedAt: number;
  latest: string | null;
  current: string;
}

function defaultCacheFile(): string {
  return join(getDataRoot(), CACHE_FILE);
}

export function formatUpdateNotice(info: UpdateInfo): string {
  const lines = [
    `A new version of ${PACKAGE_NAME} is available: ${info.current} → ${info.latest}`,
    `Upgrade with: ${UPGRADE_COMMAND}`,
  ];
  return lines.join("\n");
}

export async function checkForUpdate(options: UpdateCheckOptions = {}): Promise<UpdateInfo | null> {
  if (options.enabled === false || isDisabled()) return null;

  const now = options.now?.() ?? Date.now();
  const current = options.currentVersion ?? (await resolveInstalledVersion()) ?? "unknown";

  // Throttle: reuse a fresh cache entry instead of hitting the network.
  if (!options.force) {
    const cacheFile = options.cacheFile ?? defaultCacheFile();
    try {
      const cached: CacheEntry = JSON.parse(await readFile(cacheFile, "utf8"));
      if (
        cached.current === current &&
        typeof cached.latest === "string" &&
        now - cached.checkedAt < UPDATE_CHECK_CACHE_MS
      ) {
        return compareVersions(current, cached.latest)
          ? { latest: cached.latest, current, isUpgrade: true }
          : null;
      }
    } catch {
      // No readable cache: fall through to the network.
    }
  }

  const fetchLatest = options.fetchLatest ?? fetchLatestVersion;
  let latest: string | null = null;
  try {
    latest = await fetchLatest();
  } catch {
    latest = null;
  }

  // Persist whatever we learned so the next run is cheap.
  const cacheFile = options.cacheFile ?? defaultCacheFile();
  const entry: CacheEntry = { checkedAt: now, latest, current };
  try {
    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(entry), "utf8");
  } catch {
    // Cache write is best-effort; a read-only data dir must not break startup.
  }

  if (!latest || latest === current) return null;
  return compareVersions(current, latest)
    ? { latest, current, isUpgrade: true }
    : null;
}

/**
 * Fetch the published `latest` dist-tag from the npm registry.
 * Returns null on any failure (offline, blocked, 4xx/5xx).
 */
export async function fetchLatestVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compare two dotted-numeric versions. Returns true when `a` is strictly
 * older than `b`. Non-numeric parts are compared as numbers (0 when absent).
 * Handles the common `x.y.z[-pre]` shape used by this package.
 */
export function compareVersions(a: string, b: string): boolean {
  return isOlder(a, b);
}

function isOlder(a: string, b: string): boolean {
  const parse = (v: string): number[] =>
    v
      .split(/[.-]/)
      .map((part) => {
        const n = Number(part);
        return Number.isFinite(n) ? n : 0;
      });
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const la = left[i] ?? 0;
    const rb = right[i] ?? 0;
    if (la < rb) return true;
    if (la > rb) return false;
  }
  return false;
}

/**
 * Execute the global self-upgrade for the running install: runs
 * `npm install -g <package>` in the user's shell environment. Returns a
 * human-readable outcome string for the TUI to display.
 */
export async function runUpdateUpgrade(): Promise<string> {
  const { spawn } = await import("node:child_process");
  const child = spawn("npm", UPGRADE_COMMAND.split(" "), {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  const output: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => output.push(String(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => output.push(String(chunk)));
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(`Upgrade timed out. Run manually: ${UPGRADE_COMMAND}`);
    }, 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const tail = output.join("").trim().split("\n").slice(-3).join(" ");
      if (code === 0) {
        resolve(`Upgrade complete${tail ? ` (${tail.slice(0, 120)})` : ""}. Restart mini-agent-loop to use the new version.`);
      } else {
        resolve(`Upgrade failed (exit ${code}). ${tail} Run manually: ${UPGRADE_COMMAND}`);
      }
    });
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      resolve(`Upgrade failed to start: ${err.message}. Run manually: ${UPGRADE_COMMAND}`);
    });
  });
}

/**
 * Convenience helper used by entrypoints: run the check and print a single
 * multi-line notice to stderr when an upgrade exists. Safe to call with no
 * guards — it never throws and never blocks on a slow network (>4s aborts).
 */
export async function reportUpdateToStderr(options: UpdateCheckOptions = {}): Promise<void> {
  const info = await checkForUpdate(options);
  if (info?.isUpgrade) {
    process.stderr.write(`${formatUpdateNotice(info)}\n`);
  }
}
