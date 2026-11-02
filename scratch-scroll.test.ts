/// <reference types="./ink-testing-library.d.ts" />
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

test("wheel + PageUp scroll the context feed", async () => {
  assert.ok(render, "ink-testing-library missing");
  const cwd = mkdtempSync(path.join(tmpdir(), "mini-agent-scroll-"));
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
      // clear any autocomplete state so scroll guards see acMode = null
      view.stdin.write("\x1b"); // Esc? note: Esc aborts generation only when busy
      await waitForRender();
    }

    // Build a long-enough transcript with local commands
    for (const cmd of ["/help", "/init", "/deploy the app", "/unknown-command", "/init", "/deploy another"]) {
      await submit(cmd);
    }

    const before = view.lastFrame() ?? "";
    console.log("=== FRAME BEFORE ===\n" + before + "\n=== END FRAME BEFORE ===");

    // 1) SGR mouse wheel up
    view.stdin.write("\x1b[<64;10;5M");
    await waitForRender();
    const afterWheel = view.lastFrame() ?? "";
    console.log("=== FRAME AFTER WHEEL UP ===\n" + afterWheel + "\n=== END ===");
    console.log("wheel changed frame:", before !== afterWheel);

    // 2) PageUp
    view.stdin.write("\x1b[5~");
    await waitForRender();
    const afterPageUp = view.lastFrame() ?? "";
    console.log("pageup changed frame:", afterWheel !== afterPageUp);

    // 3) Ctrl+Down (scroll down one)
    view.stdin.write("\x1b[1;5B");
    await waitForRender();
    const afterCtrlDown = view.lastFrame() ?? "";
    console.log("ctrl-down changed frame:", afterPageUp !== afterCtrlDown);

    // 4) Ctrl+G back to bottom
    view.stdin.write("\u0007");
    await waitForRender();
    const afterCtrlG = view.lastFrame() ?? "";
    console.log("ctrl-g changed frame:", afterCtrlDown !== afterCtrlG);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    view.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
});
