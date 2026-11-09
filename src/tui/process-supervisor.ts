#!/usr/bin/env node
/**
 * Lightweight process supervisor for the mini-agent TUI.
 *
 * Avoids importing heavy dependencies so startup stays fast. Spawns the heavy
 * child process (ink-main.tsx) with auto-configured memory limits, forwards
 * signals, and re-spawns on RELAUNCH_EXIT_CODE so in-process configuration
 * changes (e.g. memory tuning) can take effect without a full user restart.
 *
 * Inspired by the dual-process architecture in Google's Gemini CLI.
 */

import { spawn } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

import { RELAUNCH_EXIT_CODE } from "./relaunch-constants.ts";

/** Re-export for callers that import from the supervisor module. */
export { RELAUNCH_EXIT_CODE };

// ---------------------------------------------------------------------------
// Memory auto-configuration
// ---------------------------------------------------------------------------

/**
 * Compute --max-old-space-size flags for the child process.
 *
 * - Honors MINI_AGENT_MAX_OLD_SPACE_MB env override when set.
 * - Respects existing --max-old-space-size in NODE_OPTIONS (won't override).
 * - Defaults to 50% of total system RAM, capped at 8 GB, leaving headroom for
 *   the OS and other tools.
 */
export function getMemoryNodeArgs(): string[] {
  const explicit = process.env.MINI_AGENT_MAX_OLD_SPACE_MB;
  if (explicit && /^\d+$/.test(explicit)) {
    return [`--max-old-space-size=${parseInt(explicit, 10)}`];
  }

  const nodeOptions = process.env.NODE_OPTIONS ?? "";
  if (nodeOptions.includes("--max-old-space-size")) {
    return [];
  }

  const totalMemoryMB = Math.floor(os.totalmem() / (1024 * 1024));
  const targetMaxOldSpaceSizeInMB = Math.min(8192, Math.floor(totalMemoryMB * 0.5));
  return [`--max-old-space-size=${targetMaxOldSpaceSizeInMB}`];
}

// ---------------------------------------------------------------------------
// Spawn helpers
// ---------------------------------------------------------------------------

/** Resolve the heavy child entry point relative to this supervisor file. */
export function resolveChildEntry(): string {
  const override = process.env.MINI_AGENT_CHILD_ENTRY;
  if (override) return override;

  const currentDir = path.dirname(fileURLToPath(import.meta.url));

  // Production bundle: dist/tui-supervisor.js lives next to dist/tui.js.
  const prodEntry = path.join(currentDir, "tui.js");
  if (currentDir.includes(`${path.sep}dist${path.sep}`)) {
    return prodEntry;
  }

  // Dev mode (tsx): src/tui/ink-main.tsx lives next to this module.
  return path.join(currentDir, "ink-main.tsx");
}

/** Build the argv + env for spawning the child process. */
export function getSpawnConfig(
  memoryArgs: string[],
  scriptArgs: string[],
): { spawnArgs: string[]; env: NodeJS.ProcessEnv } {
  const childEntry = resolveChildEntry();
  const isDev = !childEntry.includes(`${path.sep}dist${path.sep}`);

  const spawnArgs = [
    ...memoryArgs,
    ...(isDev ? ["--import", "tsx"] : []),
    childEntry,
    ...scriptArgs,
  ];

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Marker so the child knows it should run main() directly, not re-spawn.
    MINI_AGENT_CHILD: "1",
  };

  return { spawnArgs, env };
}

/** Forward common termination/interrupt signals to the child. */
export function setupSignalForwarding(
  child: import("node:child_process").ChildProcess,
): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
  const handlers = signals.map((sig) => {
    const handler = () => {
      if (!child.killed) child.kill(sig);
    };
    process.on(sig, handler);
    return handler;
  });

  return () => {
    signals.forEach((sig, i) => process.off(sig, handlers[i]!));
  };
}

// ---------------------------------------------------------------------------
// Main supervisor loop
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  // If we are already the child (or relaunch is disabled), run the main entry
  // directly instead of re-spawning (avoids infinite recursion).
  //
  // When running as the direct child entry (MINI_AGENT_CHILD=1), the tsx
  // loader may not be registered in this process, so we spawn a new child
  // with the proper loader instead of trying to import in-place. This keeps
  // the code path safe across dev (tsx) and production (ESM bundle) layouts.
  if (process.env.MINI_AGENT_NO_RELAUNCH || process.env.MINI_AGENT_CHILD) {
    const childEntry = resolveChildEntry();
    const isDev = childEntry.includes(`${path.sep}src${path.sep}`);
    const spawnArgs: string[] = [
      ...(isDev ? ["--import", "tsx"] : []),
      childEntry,
      ...process.argv.slice(2),
    ];

    // Set MINI_AGENT_CHILD=1 so the child does NOT re-spawn itself.
    const child = spawn(
      process.execPath,
      spawnArgs,
      {
        stdio: "inherit",
        env: { ...process.env, MINI_AGENT_CHILD: "1" },
      },
    );

    const removeForwarders = setupSignalForwarding(child);
    await new Promise<void>((resolve) => {
      child.on("error", (err) => {
        removeForwarders();
        process.stderr.write(`Error: failed to start child: ${err.message}\n`);
        process.exit(1);
      });
      child.on("close", (code, signal) => {
        removeForwarders();
        // Propagate exit code, or exit(1) if killed by signal.
        process.exit(signal ? 1 : (code ?? 0));
      });
    });
    return;
  }

  // --- Lightweight parent / supervisor ---

  const scriptArgs = process.argv.slice(2);
  const memoryArgs = getMemoryNodeArgs();
  const { spawnArgs, env } = getSpawnConfig(memoryArgs, scriptArgs);

  const runner = (): Promise<number> => {
    process.stdin.pause();

    const child = spawn(process.execPath, spawnArgs, {
      stdio: ["inherit", "inherit", "inherit"],
      env,
    });

    const removeForwarders = setupSignalForwarding(child);

    return new Promise<number>((resolve) => {
      child.on("error", (err) => {
        removeForwarders();
        process.stderr.write(`Error: Failed to start child process: ${err.message}\n`);
        process.stdin.resume();
        resolve(1);
      });

      child.on("close", (code, signal) => {
        removeForwarders();
        process.stdin.resume();
        if (signal) {
          // Terminated by external signal — exit, don't relaunch.
          process.exitCode = 1;
          resolve(1);
          return;
        }
        resolve(code ?? 1);
      });
    });
  };

  // Relaunch loop: re-spawn when the child exits with RELAUNCH_EXIT_CODE.
  // All other exit codes terminate the supervisor with that same code.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const exitCode = await runner();
      if (exitCode !== RELAUNCH_EXIT_CODE) {
        process.exit(exitCode);
      }
      // Relaunching: loop back so the child re-runs with the same args.
      // Memory config is re-read from env on each spawn, so an updated
      // MINI_AGENT_MAX_OLD_SPACE_MB takes effect on the next iteration.
    } catch (error) {
      process.stderr.write(
        `Fatal error: Failed to relaunch the CLI process.\n` +
          `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exit(1);
    }
  }
}

// Auto-start the supervisor loop only when this file is the direct entry
// point (process.argv[1] ends with this file name). When imported by
// ink-main.tsx (which only needs RELAUNCH_EXIT_CODE), run() is skipped to
// avoid spawning a nested supervisor.
if (process.argv[1]?.endsWith("process-supervisor.ts") || process.argv[1]?.endsWith("tui-supervisor.js")) {
  void run();
}

