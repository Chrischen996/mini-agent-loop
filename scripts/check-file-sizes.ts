#!/usr/bin/env tsx
/**
 * File-size guard: keeps hand-written source files from silently growing.
 *
 * Rules:
 * - Any scanned .ts/.tsx file with more than `limit` lines (default 1000)
 *   must be listed in scripts/file-size-baseline.json.
 * - A baselined file must not grow beyond its recorded line count.
 *   (Shrinking files are fine; run with --update-baseline to prune them.)
 *
 * Generated model catalogs (src/pi-ai/providers/**/*.models.ts) are excluded
 * because they are produced by `pnpm run generate-models` and checked for
 * drift by `generate-models:check`.
 *
 * Usage:
 *   tsx scripts/check-file-sizes.ts                # verify (CI)
 *   tsx scripts/check-file-sizes.ts --update-baseline  # refresh baseline for current offenders
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { execSync } from "node:child_process";

const DEFAULT_LIMIT = 1000;
const SCAN_ROOTS = ["src", "apps/web/src"];
const BASELINE_PATH = "scripts/file-size-baseline.json";
// Generated catalogs — do not police these by hand.
const GENERATED_FILE_RE = /(^|\/)providers\/.*\.models\.ts$/;

type BaselineEntry = { path: string; lines: number; note?: string };

function isFlag(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

function gitListFiles(root: string): string[] {
  // Use git to enumerate tracked files so untracked noise (dist/, coverage/) is skipped.
  const out = execSync(`git ls-files -- '${root}'`, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return out.split("\n").filter((line) => line.trim().length > 0);
}

function countLines(file: string): number {
  const content = readFileSync(file, "utf8");
  // Split on any newline convention; trailing newline must not add an empty line.
  const lines = content.split(/\r?\n/);
  return lines.length - (lines[lines.length - 1] === "" ? 1 : 0);
}

function main(): void {
  const updateBaseline = isFlag("--update-baseline");
  const limit = Number.parseInt(argValue("--limit", String(DEFAULT_LIMIT)), 10);
  const cwd = process.cwd();

  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of gitListFiles(root)) {
      if (!/\.(ts|tsx)$/.test(file)) continue;
      if (GENERATED_FILE_RE.test(file)) continue;
      files.push(file);
    }
  }
  files.sort();

  const offenders: { path: string; lines: number }[] = [];
  for (const file of files) {
    const lines = countLines(resolve(cwd, file));
    if (lines > limit) offenders.push({ path: file, lines });
  }

  const baselinePath = resolve(cwd, BASELINE_PATH);
  const baseline: BaselineEntry[] = existsSync(baselinePath)
    ? (JSON.parse(readFileSync(baselinePath, "utf8")) as BaselineEntry[])
    : [];

  if (updateBaseline) {
    const entries: BaselineEntry[] = offenders.map((entry) => {
      const previous = baseline.find((b) => b.path === entry.path);
      return {
        path: entry.path,
        lines: entry.lines,
        note: previous?.note,
      };
    });
    entries.sort((a, b) => b.lines - a.lines);
    mkdirSync(resolve(cwd, "scripts"), { recursive: true });
    writeFileSync(
      baselinePath,
      JSON.stringify({ limit, entries }, null, 2) + "\n",
      "utf8",
    );
    console.log(`[check-file-sizes] baseline updated with ${entries.length} entries (limit ${limit}).`);
    return;
  }

  const baselineMap = new Map(baseline.map((entry) => [entry.path, entry]));
  const errors: string[] = [];
  const resolved: string[] = [];
  const shrunken: string[] = [];

  for (const { path: file, lines } of offenders) {
    const entry = baselineMap.get(file);
    if (!entry) {
      errors.push(`${file}: ${lines} lines (new, exceeds ${limit}-line limit — split the file or add it to the baseline)`);
    } else if (lines > entry.lines) {
      errors.push(
        `${file}: ${lines} lines (grew beyond baselined ${entry.lines} — split the file, or run with --update-baseline to accept the growth)`,
      );
    } else if (lines <= limit) {
      // Cannot happen: offender means lines > limit.
    } else {
      shrunken.push(`${file}: ${lines} lines (baselined at ${entry.lines}, below limit — candidate for baseline cleanup)`);
    }
  }

  // Detect stale baseline entries (file deleted or now under the limit).
  const offenderPaths = new Set(offenders.map((o) => o.path));
  for (const entry of baseline) {
    if (offenderPaths.has(entry.path)) continue;
    if (files.includes(entry.path)) {
      resolved.push(`${entry.path}: now ${countLines(resolve(cwd, entry.path))} lines — remove from baseline via --update-baseline`);
    } else {
      resolved.push(`${entry.path}: no longer exists — remove from baseline via --update-baseline`);
    }
  }

  console.log(`[check-file-sizes] limit: ${limit} lines; scanned ${files.length} files; ${offenders.length} exceed the limit.`);
  if (offenders.length > 0) {
    console.log("[check-file-sizes] current offenders:");
    for (const { path: file, lines } of offenders) {
      const entry = baselineMap.get(file);
      const marker = entry ? ` (baselined at ${entry.lines})` : " (NOT BASELINED)";
      console.log(`  ${String(lines).padStart(6)}  ${file}${marker}`);
    }
  }
  for (const line of [...shrunken, ...resolved]) console.log(`  hint: ${line}`);

  if (errors.length > 0) {
    console.error(`[check-file-sizes] FAILED with ${errors.length} violation(s):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
  } else {
    console.log("[check-file-sizes] OK — no regressions against the baseline.");
  }
}

main();
