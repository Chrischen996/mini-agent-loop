#!/usr/bin/env node
/**
 * `npm run tui` launcher with a dev bundle cache.
 *
 * The problem it solves: `node --import tsx` pays the whole TUI module graph on
 * every launch — ESM linking of ~3000 modules (~0.75 s, before any module body
 * runs) plus tsx's on-demand transpile of ~330 TypeScript files. That is the
 * blank screen users stare at for about a second.
 *
 * The graph only changes when the sources change, so this launcher keeps ONE
 * prebuilt bundle in `.cache/tui-dev/` (same Vite/SSR recipe as `dist/tui.js`,
 * stamped with a cheap source fingerprint):
 *
 *   - cache fresh  → run the bundle directly (~0.5 s of module load instead
 *                    of ~1.1 s of tsx linking)
 *   - cache stale  → run the normal tsx path for THIS launch (never stale code)
 *                    and rebuild the bundle in a detached background process,
 *                    so the next launch is fast
 *   - `MINI_AGENT_TUI_DEV_CACHE=refresh` → block and rebuild, then run
 *   - `MINI_AGENT_TUI_DEV_CACHE=0` → always the tsx path, no cache at all
 *
 * This file runs under plain `node` (Node >= 22.19 strips types without a
 * loader), so it and the two modules it imports must stay type-strip friendly:
 * no `enum`, no `namespace`, no constructor parameter properties.
 *
 * Supervisor semantics are preserved: `--max-old-space-size` auto config,
 * `MINI_AGENT_CHILD=1`, signal forwarding, RELAUNCH_EXIT_CODE restart loop, and
 * `NODE_COMPILE_CACHE` for the V8 code cache of the bundle.
 */
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  acquireBuildLock,
  computeSourceFingerprint,
  isDevBundleFresh,
  readDevBundleMeta,
  releaseBuildLock,
  resolveDevBundlePaths,
  writeDevBundleMeta,
  DEV_BUNDLE_CACHE_VERSION,
  type DevBundlePaths,
} from "./dev-bundle-cache.ts";
import { BOOT_FRAME_ENV, paintBootFrame } from "./boot-frame.ts";
import { resolveTuiLayoutMode } from "./layout-mode.ts";
import { getMemoryNodeArgs, RELAUNCH_EXIT_CODE } from "./process-supervisor.ts";

const CACHE_ENV = "MINI_AGENT_TUI_DEV_CACHE";
const QUIET_ENV = "MINI_AGENT_TUI_DEV_CACHE_QUIET";
/** Hidden argv flag: this process is the detached cache builder. */
const BUILD_ONLY_FLAG = "--build-dev-cache";
/** Wait before the background build so it cannot compete with the first frame. */
const BACKGROUND_BUILD_DELAY_MS = 2500;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const entryPath = path.join(here, "ink-main.tsx");
const selfPath = fileURLToPath(import.meta.url);

function log(message: string): void {
  if (process.env[QUIET_ENV] === "1") return;
  process.stderr.write(`[tui] ${message}\n`);
}

function currentFingerprint(): string {
  return computeSourceFingerprint({
    srcDir: path.join(repoRoot, "src"),
    extraFiles: [path.join(repoRoot, "package.json")],
  });
}

// ---------------------------------------------------------------------------
// Child supervision (shared by the bundled and the tsx path)
// ---------------------------------------------------------------------------

/** Forward termination signals so Ctrl+C reaches the TUI child exactly once. */
function forwardSignals(child: ChildProcess): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
  const handlers = signals.map((signal) => {
    const handler = () => {
      if (!child.killed) child.kill(signal);
    };
    process.on(signal, handler);
    return handler;
  });
  return () => signals.forEach((signal, index) => process.off(signal, handlers[index]!));
}

function superviseOnce(nodeArgs: string[], env: NodeJS.ProcessEnv): Promise<number> {
  process.stdin.pause();
  const child = spawn(process.execPath, nodeArgs, { stdio: "inherit", env });
  const removeForwarders = forwardSignals(child);
  return new Promise<number>((resolve) => {
    child.on("error", (error) => {
      removeForwarders();
      process.stderr.write(`[tui] failed to start child: ${error.message}\n`);
      resolve(1);
    });
    child.on("close", (code, signal) => {
      removeForwarders();
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

/** Mirrors the supervisor: restart on RELAUNCH_EXIT_CODE, otherwise propagate. */
async function superviseLoop(nodeArgs: string[], env: NodeJS.ProcessEnv): Promise<never> {
  let childProcessEnv = env;
  for (;;) {
    const exitCode = await superviseOnce(nodeArgs, childProcessEnv);
    if (exitCode !== RELAUNCH_EXIT_CODE) {
      process.exit(exitCode);
    }
    // Relaunch: the boot line was erased minutes ago, so the next child must
    // not erase a line of the transcript.
    const { [BOOT_FRAME_ENV]: _paintedBootFrame, ...withoutBootFrame } = childProcessEnv;
    childProcessEnv = withoutBootFrame;
  }
}

function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // V8 code cache, shared by both paths: ~60 ms off every launch after the first.
    NODE_COMPILE_CACHE: path.join(repoRoot, ".cache", "node-compile"),
    ...extra,
  };
}

/**
 * Print the boot line, then supervise the child with the marker that lets it
 * erase that line. Returns only by exiting.
 */
function runSupervised(nodeArgs: string[], extraEnv: NodeJS.ProcessEnv): Promise<never> {
  const painted = paintBootFrame({
    env: process.env,
    stdout: process.stdout,
    layoutMode: resolveTuiLayoutMode(),
  });
  const env = childEnv({ ...extraEnv, ...(painted ? { [BOOT_FRAME_ENV]: "1" } : {}) });
  // Only the child spawned below may erase; see superviseLoop's relaunch path.
  if (painted) delete process.env[BOOT_FRAME_ENV];
  return superviseLoop(nodeArgs, env);
}

/**
 * Source path: same child the supervisor would spawn (`node --import tsx
 * ink-main.tsx`), but spawned straight from here. That skips the extra
 * node+tsx process `process-supervisor.ts` used to add (~200 ms of the blank
 * window) while keeping the memory args, `MINI_AGENT_CHILD` marker and
 * RELAUNCH loop that supervisor provided.
 */
function runFromSource(scriptArgs: string[]): Promise<never> {
  return runSupervised(
    [...getMemoryNodeArgs(), "--import", "tsx", entryPath, ...scriptArgs],
    { MINI_AGENT_CHILD: "1" },
  );
}

function runBundle(paths: DevBundlePaths, scriptArgs: string[]): Promise<never> {
  return runSupervised(
    [...getMemoryNodeArgs(), paths.bundlePath, ...scriptArgs],
    { MINI_AGENT_CHILD: "1" },
  );
}

// ---------------------------------------------------------------------------
// Bundle build
// ---------------------------------------------------------------------------

/**
 * Bundle the TUI entry with the same Vite/SSR recipe `build.ts` uses for
 * `dist/tui.js`, into a staging directory that is swapped in atomically — a
 * concurrent launcher can never import a half-written bundle.
 */
export async function buildBundle(paths: DevBundlePaths): Promise<void> {
  const [{ build }, { nodeResolve }, { builtinModules }] = await Promise.all([
    import("vite"),
    import("@rollup/plugin-node-resolve"),
    import("node:module"),
  ]);
  const nodeBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
  // Stamp the sources as they are BEFORE building: an edit made while the build
  // runs then invalidates the bundle on the next launch instead of being baked
  // in under a "fresh" stamp.
  const fingerprint = currentFingerprint();

  rmSync(paths.stagingDir, { recursive: true, force: true });
  mkdirSync(paths.stagingDir, { recursive: true });

  await build({
    configFile: false,
    root: repoRoot,
    logLevel: "warn",
    build: {
      ssr: true,
      target: "node22",
      outDir: paths.stagingDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      rollupOptions: {
        input: entryPath,
        output: {
          entryFileNames: "tui.js",
          chunkFileNames: "[name]-[hash].js",
          format: "esm",
        },
        // Same externals as dist/tui.js: react/ink stay in node_modules.
        external: (id: string) =>
          id === "react" || id === "react-dom" || id === "ink" || nodeBuiltins.has(id),
      },
    },
    plugins: [nodeResolve({ preferBuiltins: true })],
  });

  writeDevBundleMeta(path.join(paths.stagingDir, "meta.json"), {
    version: DEV_BUNDLE_CACHE_VERSION,
    fingerprint,
    builtAt: Date.now(),
  });

  // Swap without a window where the cache is missing: move the old build aside,
  // move the new one in, then delete the old one. A crash in between leaves a
  // usable cache dir rather than nothing.
  rmSync(paths.previousDir, { recursive: true, force: true });
  try {
    renameSync(paths.cacheDir, paths.previousDir);
  } catch {
    // First build: there is nothing to move aside.
  }
  renameSync(paths.stagingDir, paths.cacheDir);
  rmSync(paths.previousDir, { recursive: true, force: true });
}

/**
 * Detached `--build-dev-cache` process: rebuild without blocking the TUI.
 * Output goes to `.cache/tui-dev-build.log` so a failing build can be
 * diagnosed instead of silently retrying on every launch.
 */
function spawnBackgroundBuild(): void {
  let stdio: StdioOptions = "ignore";
  let logFd: number | undefined;
  try {
    mkdirSync(path.join(repoRoot, ".cache"), { recursive: true });
    logFd = openSync(path.join(repoRoot, ".cache", "tui-dev-build.log"), "w");
    stdio = ["ignore", logFd, logFd];
  } catch {
    stdio = "ignore";
  }
  const child = spawn(process.execPath, ["--import", "tsx", selfPath, BUILD_ONLY_FLAG], {
    detached: true,
    stdio,
    env: childEnv(),
  });
  child.unref();
  // The detached child owns its dup of the descriptor; the launcher must not
  // keep its own copy open while the TUI session runs.
  if (logFd !== undefined) {
    try {
      closeSync(logFd);
    } catch {
      // Nothing useful to do — the child still has its copy.
    }
  }
}

async function runCacheBuilder(): Promise<void> {
  const paths = resolveDevBundlePaths(repoRoot);
  if (!acquireBuildLock(paths.lockPath)) return;
  const startedAt = Date.now();
  try {
    await buildBundle(paths);
    log(`dev bundle rebuilt in ${Date.now() - startedAt}ms — the next launch is fast`);
  } catch (error) {
    log(`dev bundle build failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    releaseBuildLock(paths.lockPath);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.argv.includes(BUILD_ONLY_FLAG)) {
    await runCacheBuilder();
    return;
  }

  const scriptArgs = process.argv.slice(2);
  const mode = (process.env[CACHE_ENV] ?? "").trim().toLowerCase();
  if (mode === "0" || mode === "off" || mode === "false") {
    await runFromSource(scriptArgs);
    return;
  }

  const paths = resolveDevBundlePaths(repoRoot);
  const fingerprint = currentFingerprint();
  if (mode !== "refresh" && isDevBundleFresh(paths, readDevBundleMeta(paths.metaPath), fingerprint)) {
    await runBundle(paths, scriptArgs);
    return;
  }

  if (mode === "refresh") {
    const startedAt = Date.now();
    log("rebuilding dev bundle (refresh requested)…");
    if (!acquireBuildLock(paths.lockPath)) {
      log("another build is already running — using the tsx path for this launch");
      await runFromSource(scriptArgs);
      return;
    }
    try {
      await buildBundle(paths);
      log(`dev bundle ready in ${Date.now() - startedAt}ms`);
    } catch (error) {
      log(`dev bundle build failed: ${error instanceof Error ? error.message : String(error)}`);
      await runFromSource(scriptArgs);
      return;
    } finally {
      releaseBuildLock(paths.lockPath);
    }
    await runBundle(paths, scriptArgs);
    return;
  }

  // Stale: this launch stays on the always-current tsx path, and a detached
  // rebuild runs after the frame is up so the NEXT launch is fast.
  log("sources changed — running via tsx this launch while rebuilding the dev bundle in the background");
  const timer = setTimeout(spawnBackgroundBuild, BACKGROUND_BUILD_DELAY_MS);
  timer.unref();
  await runFromSource(scriptArgs);
}

// Auto-start only as the direct entry (`node --import tsx src/tui/dev-launch.ts`);
// importing this module from tests must not spawn anything.
if (process.argv[1]?.endsWith("dev-launch.ts")) {
  void main();
}

export { main };
