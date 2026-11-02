/// <reference types="ink-testing-library.d.ts" />
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import React from "react";
import { App } from "./src/tui/App.tsx";

let render: typeof import("ink-testing-library").render | undefined;
try {
  ({ render } = await import("ink-testing-library"));
} catch (error: unknown) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "MODULE_NOT_FOUND") throw error;
}

const waitForRender = () => new Promise<void>((resolve) => setTimeout(resolve, 80));

test("x10 wheel + kitty pageup probe", async () => {
  assert.ok(render, "ink-testing-library missing");
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-agent-wheel2-"));
  const previous: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries({
    AGENT_DATA_DIR: "",
    MINI_AGENT_UPDATE_CHECK: "0",
    OPENAI_MODEL: "openai/gpt-4o",
    OPENAI_API_KEY: "not-a-real-key",
  })) {
    previous[name] = process.env[name];
    process.env[name] = name === "AGENT_DATA_DIR" ? cwd : value;
  }

  const view = render!(React.createElement(App, { cwd, agentTools: [], allTools: [] }), { columns: 80, rows: 10 });
  try {
    async function submit(command: string) {
      await waitForRender();
      view.stdin.write(command);
      await waitForRender();
      view.stdin.write("\r");
      await waitForRender();
      view.stdin.write("\x1b");
      await waitForRender();
    }
    for (const cmd of ["/help", "/init", "/deploy the app", "/unknown-command", "/init", "/deploy another"]) {
      await submit(cmd);
    }

    // 1) X10 normal-mode wheel up: ESC [ M `  (button code 64 + 32 = '`')
    const beforeX10 = view.lastFrame() ?? "";
    view.stdin.write("\x1b[M`");
    await waitForRender();
    const afterX10 = view.lastFrame() ?? "";
    console.log("X10 wheel-up changed frame:", beforeX10 !== afterX10);
    console.log("prompt leaked garbage:", afterX10.includes("[M`"));

    // 2) kitty protocol PageUp: ESC [ 5 ; 129 u
    const beforeKitty = view.lastFrame() ?? "";
    view.stdin.write("\x1b[9u");
    await waitForRender();
    const afterKitty = view.lastFrame() ?? "";
    console.log("kitty pageup changed frame:", beforeKitty !== afterKitty);
    console.log("=== AFTER KITTY PAGEUP ===\n" + afterKitty + "\n=== END ===");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    view.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
});
