import React from "react";
import { render } from "ink";
import { App } from "./App.tsx";
import { createAllTools, createTools, createToolsWithSandbox } from "../tools/index.ts";
import { createSandboxRunner } from "../sandbox/index.ts";
import { createMcpRuntimeFromEnv } from "../mcp/runtime.ts";
import { createCodebaseRuntimeFromEnv } from "../codebase/runtime.ts";

const cwd = process.cwd();

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write("Hermes TUI requires an interactive terminal\n");
  process.exit(1);
}

async function main(): Promise<void> {
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
    const agentTools = createTools(cwd, {
      codebase: process.env.EXTERNAL_CODEBASE_ENABLED !== "0",
      codebaseStore: codebaseRuntime.store,
      codebaseProvider: codebaseRuntime.semanticProvider,
      sandboxRunner,
    });
    const app = render(
      <App
        cwd={cwd}
        agentTools={mcpRuntime.toolProvider(agentTools)}
        allTools={mcpRuntime.toolProvider(createAllTools(cwd, { sandboxRunner }))}
      />,
    );
    await app.waitUntilExit();
  } finally {
    await Promise.all([mcpRuntime.close(), codebaseRuntime.close(), sandboxRunner?.cleanup() ?? Promise.resolve()]);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
