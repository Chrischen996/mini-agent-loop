import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/tui/App.tsx";

const waitForRender = () => new Promise<void>((resolve) => setTimeout(resolve, 60));

// Keep this suite offline and separate from a developer's saved profiles or
// sessions. The fake key is never sent to a provider: these are local commands.
const overrides = {
  AGENT_DATA_DIR: "",
  MINI_AGENT_UPDATE_CHECK: "0",
  OPENAI_MODEL: "openai/gpt-4o",
  OPENAI_API_KEY: "not-a-real-key",
} as const;

describe("the single Ink terminal", () => {
  let cwd: string;
  let previous: Record<keyof typeof overrides, string | undefined>;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "mini-agent-ink-"));
    previous = Object.fromEntries(
      Object.keys(overrides).map((name) => [name, process.env[name]]),
    ) as typeof previous;
    for (const [name, value] of Object.entries(overrides)) {
      process.env[name] = name === "AGENT_DATA_DIR" ? cwd : value;
    }
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  function open() {
    return render(React.createElement(App, { cwd, agentTools: [], allTools: [] }));
  }

  async function submit(view: ReturnType<typeof open>, command: string) {
    // Ink finishes mounting its input subscriptions on the next tick.
    await waitForRender();
    view.stdin.write(command);
    await waitForRender();
    view.stdin.write("\r");
    await waitForRender();
  }

  it("uses Ink for the same Claude Code-style welcome and prompt as the released UI", () => {
    const view = open();
    try {
      const frame = view.lastFrame() ?? "";
      assert.match(frame, /mini-agent v/);
      assert.match(frame, /Welcome back!/);
      assert.match(frame, /❯ Message, \/command, or @file reference/);
      assert.match(frame, /Plan mode/);
    } finally {
      view.cleanup();
    }
  });

  it("handles the command catalog and unknown commands locally", async () => {
    const view = open();
    try {
      await submit(view, "/help");
      assert.match(view.lastFrame() ?? "", /\/help\s+Show help/);
      assert.match(view.lastFrame() ?? "", /\/init \[--force\] \[--print\]/);

      await submit(view, "/deploy the app");
      assert.match(view.lastFrame() ?? "", /\/deploy is not a command/);
      assert.doesNotMatch(view.lastFrame() ?? "", /Working…/);
    } finally {
      view.cleanup();
    }
  });

  it("opens the Ink model picker instead of submitting a model turn", async () => {
    const view = open();
    try {
      await submit(view, "/model");
      assert.match(view.lastFrame() ?? "", /Search models/);
      assert.match(view.lastFrame() ?? "", /Enter select/);
      assert.match(view.lastFrame() ?? "", /Plan mode/);
    } finally {
      view.cleanup();
    }
  });

  it("previews /init without calling a provider or writing AGENT.MD", async () => {
    const view = open();
    try {
      await submit(view, "/init --print");
      assert.match(view.lastFrame() ?? "", /## Development Commands/);
      assert.equal(existsSync(path.join(cwd, "AGENT.MD")), false);
    } finally {
      view.cleanup();
    }
  });

  it("routes both published TUI commands to Ink without a renderer switch", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      bin: Record<string, string>;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.scripts.tui, "tsx src/tui/ink-main.tsx");
    assert.equal(pkg.bin["mini-agent-loop"], "dist/tui.js");
    assert.equal(pkg.bin["mini-agent-loop-tui"], "dist/tui.js");
    assert.equal(pkg.bin["mini-agent-loop-terminal"], undefined);
    assert.equal(pkg.scripts["tui:terminal"], undefined);
    assert.equal(pkg.dependencies["@earendil-works/pi-tui"], undefined);
  });
});
