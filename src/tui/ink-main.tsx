#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import path from "node:path";
import { App } from "./App.tsx";
import { createAllTools, createTools, createBgTaskSuite, createBgTaskTools } from "../tools/index.ts";
import { BgTaskManager, stableBgTaskInstanceId } from "../bg-tasks/manager.js";
import { createSandboxRunner } from "../sandbox/index.ts";
import { createMcpRuntimeFromEnv } from "../mcp/runtime.ts";
import { createCodebaseRuntimeFromEnv } from "../codebase/runtime.ts";
import { createIncrementalStdout } from "./incremental-renderer.ts";
import { disableMouseTracking, enableMouseTracking } from "./mouse-tracking.ts";
import { openInspectorFromArgs } from "./inspect.ts";
import { getStartupSessionRequest } from "./session-serialization.ts";
import { loadTuiSystemPromptContext } from "./system-prompt.ts";
import { RELAUNCH_EXIT_CODE } from "./relaunch-constants.ts";

const cwd = process.cwd();

// Keep Ink's frequent redraws isolated from the shell's main screen. This is
// also what prevents a completed TUI session from leaving its frame in the
// user's scrollback buffer.
const ALTERNATE_SCREEN = "\x1b[?1049h";
const MAIN_SCREEN = "\x1b[?1049l";

// Parse command line arguments for debugging/inspection
const args = process.argv.slice(2);
const startupSessionRequest = getStartupSessionRequest(args);

async function runMain(): Promise<void> {
  // Guard: only the interactive terminal entry may run main().
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("mini-agent TUI requires an interactive terminal\n");
    process.exit(1);
  }

  const codebaseRuntime = createCodebaseRuntimeFromEnv();
  const mcpRuntime = await createMcpRuntimeFromEnv(cwd).catch(async (error) => {
    await codebaseRuntime.close();
    throw error;
  });

  // Initialize sandbox runner if enabled
  let sandboxRunner: Awaited<ReturnType<typeof createSandboxRunner>> | undefined;
  const sandboxEnabled = process.env.MINI_AGENT_SANDBOX !== "0" && process.env.MINI_AGENT_SANDBOX !== "false";
  if (sandboxEnabled) {
    try {
      sandboxRunner = await createSandboxRunner({
        enabled: true,
        type: (process.env.MINI_AGENT_SANDBOX_TYPE as "auto" | "docker" | "node" | "none" | undefined) ?? "auto",
        dockerImage: process.env.MINI_AGENT_SANDBOX_IMAGE,
        allowNetwork: process.env.MINI_AGENT_SANDBOX_NETWORK === "true",
        cpuLimit: process.env.MINI_AGENT_SANDBOX_CPUS ? parseFloat(process.env.MINI_AGENT_SANDBOX_CPUS) : undefined,
        memoryLimit: process.env.MINI_AGENT_SANDBOX_MEMORY,
        timeout: process.env.MINI_AGENT_SANDBOX_TIMEOUT ? parseInt(process.env.MINI_AGENT_SANDBOX_TIMEOUT, 10) : undefined,
      });
      console.error(`[sandbox] initialized type=${sandboxRunner.type}`);
    } catch (error) {
      console.error(`[sandbox] failed to initialize: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    let bgTaskDispose: (() => void) | undefined;
    let bgTools: import("../tools/types.ts").Tool[] = [];
    const bgToolsByCwd = new Map<string, import("../tools/types.ts").Tool[]>();
    const bgManagersByCwd = new Map<string, BgTaskManager>();
    const childBgManagers = new Map<string, BgTaskManager>();
    const bgEnabled = process.env.MINI_AGENT_BG_TASKS !== "0" && process.env.MINI_AGENT_BG_TASKS !== "false";
    if (bgEnabled) {
      try {
        const bg = await createBgTaskSuite(cwd);
        bgTools = bg.tools;
        bgToolsByCwd.set(path.resolve(cwd), bgTools);
        bgManagersByCwd.set(path.resolve(cwd), bg.manager);
        bgTaskDispose = bg.dispose;
      } catch (bgError) {
        console.error(`[bg-tasks] failed to initialize: ${bgError instanceof Error ? bgError.message : String(bgError)}\n`);
      }
    }
    const bgManagerForCwd = (workspaceCwd: string): BgTaskManager | undefined => {
      if (!bgEnabled) return undefined;
      const key = path.resolve(workspaceCwd);
      const existing = bgManagersByCwd.get(key);
      if (existing) return existing;
      const manager = new BgTaskManager(key, stableBgTaskInstanceId(key));
      bgManagersByCwd.set(key, manager);
      childBgManagers.set(key, manager);
      return manager;
    };
    const bgToolsForCwd = (workspaceCwd: string) => {
      const key = path.resolve(workspaceCwd);
      const existing = bgToolsByCwd.get(key);
      if (existing) return existing;
      const manager = bgManagerForCwd(workspaceCwd);
      if (!manager) return [];
      const tools = createBgTaskTools(manager);
      bgToolsByCwd.set(key, tools);
      return tools;
    };
    const agentToolsForCwd = (workspaceCwd: string) => mcpRuntime.toolProvider([
      ...createTools(workspaceCwd, {
        codebase: process.env.EXTERNAL_CODEBASE_ENABLED !== "0",
        codebaseStore: codebaseRuntime.store,
        codebaseProvider: codebaseRuntime.semanticProvider,
        sandboxRunner,
        backgroundTaskManager: bgManagerForCwd(workspaceCwd),
      }),
      ...bgToolsForCwd(workspaceCwd),
    ]);
    const allToolsForCwd = (workspaceCwd: string) => mcpRuntime.toolProvider([
      ...createAllTools(workspaceCwd, { sandboxRunner, backgroundTaskManager: bgManagerForCwd(workspaceCwd) }),
      ...bgToolsForCwd(workspaceCwd),
    ]);
    const systemPromptContext = await loadTuiSystemPromptContext(cwd);
    process.stdout.write(ALTERNATE_SCREEN);
    enableMouseTracking(process.stdout);
    const incrementalStdout = createIncrementalStdout(process.stdout);
    const app = render(
      <App
        cwd={cwd}
        systemPromptContext={systemPromptContext}
        startupSessionRequest={startupSessionRequest}
        agentToolsForCwd={agentToolsForCwd}
        allToolsForCwd={allToolsForCwd}
        bgManagerForCwd={bgManagerForCwd}
        mcpStatuses={() => mcpRuntime.statuses()}
        mcpTools={() => mcpRuntime.snapshot()}
      />,
      { stdout: incrementalStdout },
    );
    await app.waitUntilExit();
    bgTaskDispose?.();
    for (const manager of childBgManagers.values()) manager.dispose();
  } finally {
    disableMouseTracking(process.stdout);
    process.stdout.write(MAIN_SCREEN);
    await Promise.all([mcpRuntime.close(), codebaseRuntime.close(), sandboxRunner?.cleanup() ?? Promise.resolve()]);
  }
}

/**
 * Run the TUI entry point. Exported so the process supervisor can invoke it
 * directly when running as the child process (MINI_AGENT_CHILD=1).
 */
export async function main(): Promise<void> {
  await runMain();
}

export { RELAUNCH_EXIT_CODE };

export default main;

// Run the TUI when invoked directly as a script (node / tsx / bundle entry).
// When imported by the process supervisor, process.argv[1] is the supervisor
// path, so this guard does not fire — the supervisor calls main() explicitly.
if (
  process.argv[1] &&
  (process.argv[1].endsWith("ink-main.tsx") || process.argv[1].endsWith("tui.js"))
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
