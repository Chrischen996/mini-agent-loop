import React from "react";
import { render } from "ink";
import { App } from "./App.tsx";
import { createAllTools, createTools } from "../tools/index.ts";
import { createMcpRuntimeFromEnv, mergeToolSets } from "../mcp/runtime.ts";
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
  try {
    const mcpTools = mcpRuntime.snapshot();
    const app = render(
      <App
        cwd={cwd}
        agentTools={mergeToolSets(
          createTools(cwd, {
            codebase: process.env.EXTERNAL_CODEBASE_ENABLED !== "0",
            codebaseStore: codebaseRuntime.store,
            codebaseProvider: codebaseRuntime.semanticProvider,
          }),
          mcpTools,
        )}
        allTools={mergeToolSets(createAllTools(cwd), mcpTools)}
      />,
    );
    await app.waitUntilExit();
  } finally {
    await Promise.all([mcpRuntime.close(), codebaseRuntime.close()]);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
