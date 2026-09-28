/// <reference types="../ink-testing-library.d.ts" />
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import React, { useState } from "react";
import { App } from "../src/tui/App.tsx";
import { PromptInput } from "../src/tui/components/PromptInput.tsx";

const require = createRequire(import.meta.url);
let render: typeof import("ink-testing-library").render | undefined;
try {
  ({ render } = require("ink-testing-library") as typeof import("ink-testing-library"));
} catch (error: unknown) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "MODULE_NOT_FOUND") throw error;
}

const waitForRender = () => new Promise<void>((resolve) => setTimeout(resolve, 60));

// Keep this suite offline and separate from a developer's saved profiles or
// sessions. The fake key is never sent to a provider: these are local commands.
const overrides = {
  AGENT_DATA_DIR: "",
  MINI_AGENT_UPDATE_CHECK: "0",
  OPENAI_MODEL: "openai/gpt-4o",
  OPENAI_API_KEY: "not-a-real-key",
  TUI_CLAUDE_STYLE_INPUT: "1",
} as const;

const suiteDescriptor = render ? describe : describe.skip;

suiteDescriptor("the single Ink terminal", () => {
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

  function open(dimensions: { columns?: number; rows?: number } = {}) {
    return render!(React.createElement(App, { cwd, agentTools: [], allTools: [] }), dimensions);
  }

  async function submit(view: ReturnType<typeof open>, command: string) {
    // Ink finishes mounting its input subscriptions on the next tick.
    await waitForRender();
    view.stdin.write(command);
    await waitForRender();
    view.stdin.write("\r");
    await waitForRender();
  }

  it("moves PromptInput by words for Ctrl+Arrow without modifying the draft", async () => {
    function PromptHarness(): React.ReactElement {
      const [value, setValue] = useState("one two");
      return React.createElement(PromptInput, {
        value,
        onChange: setValue,
        onSubmit: () => {},
        enhancedEditingEnabled: true,
      });
    }

    const view = render!(React.createElement(PromptHarness));
    try {
      await waitForRender();
      view.stdin.write("\x1b[1;5D");
      await waitForRender();
      view.stdin.write("X");
      await waitForRender();

      assert.match(view.lastFrame() ?? "", /one Xtwo/);
    } finally {
      view.cleanup();
    }
  });

  it("does not let word navigation modify an overlay-owned prompt", async () => {
    function PromptHarness(): React.ReactElement {
      const [value, setValue] = useState("one two");
      return React.createElement(PromptInput, {
        value,
        onChange: setValue,
        onSubmit: () => {},
        enhancedEditingEnabled: true,
        disableArrowNavigation: true,
      });
    }

    const view = render!(React.createElement(PromptHarness));
    try {
      await waitForRender();
      view.stdin.write("\x1b[1;5D");
      await waitForRender();
      view.stdin.write("X");
      await waitForRender();

      assert.match(view.lastFrame() ?? "", /one twoX/);
    } finally {
      view.cleanup();
    }
  });

  it("renders the Claude-style input container at supported terminal widths", () => {
    for (const columns of [20, 40, 80]) {
      const view = open({ columns, rows: 24 });
      try {
        const frame = view.lastFrame() ?? "";
        assert.match(frame, /╭/);
        assert.match(frame, /❯/);
      } finally {
        view.cleanup();
      }
    }
  });

  it("falls back to the unbordered prompt below the minimum input width", () => {
    const view = open({ columns: 19, rows: 24 });
    try {
      const frame = view.lastFrame() ?? "";
      assert.doesNotMatch(frame, /╭/);
      assert.match(frame, /❯/);
    } finally {
      view.cleanup();
    }
  });

  it("uses Ink for the same Claude Code-style welcome and prompt as the released UI", () => {
    const view = open({ columns: 80, rows: 24 });
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

  it("preserves multiline editing and renders the active line", async () => {
    function PromptHarness(): React.ReactElement {
      const [value, setValue] = useState("one");
      return React.createElement(PromptInput, {
        value,
        onChange: setValue,
        onSubmit: () => {},
        enhancedEditingEnabled: true,
      });
    }

    const view = render!(React.createElement(PromptHarness));
    try {
      await waitForRender();
      view.stdin.write("\x1b[13;2u");
      await waitForRender();
      view.stdin.write("two");
      await waitForRender();

      assert.match(view.lastFrame() ?? "", /one/);
      assert.match(view.lastFrame() ?? "", /two/);
    } finally {
      view.cleanup();
    }
  });

  it("keeps a long placeholder visible at the supported minimum width", () => {
    function PromptHarness(): React.ReactElement {
      return React.createElement(PromptInput, {
        value: "",
        onChange: () => {},
        onSubmit: () => {},
        placeholder: "Message, /command, or @file reference with a long hint",
      });
    }

    const view = render!(React.createElement(PromptHarness), { columns: 20, rows: 8 });
    try {
      const frame = view.lastFrame() ?? "";
      assert.match(frame, /Message, \/command/);
      assert.match(frame, /@file reference/);
    } finally {
      view.cleanup();
    }
  });

  it("keeps image attachments and the prompt visible together", () => {
    function PromptHarness(): React.ReactElement {
      return React.createElement(PromptInput, {
        value: "draft text",
        onChange: () => {},
        onSubmit: () => {},
        attachments: ["first-image.png", "a-very-long-second-image-name.png"],
        placeholder: "Message",
      });
    }

    const view = render!(React.createElement(PromptHarness), { columns: 20, rows: 8 });
    try {
      const frame = view.lastFrame() ?? "";
      assert.match(frame, /Image #1/);
      assert.match(frame, /Image #2/);
      assert.match(frame, /draft text/);
    } finally {
      view.cleanup();
    }
  });

  it("keeps the prompt mounted in a short terminal", () => {
    const view = open({ columns: 40, rows: 6 });
    try {
      const frame = view.lastFrame() ?? "";
      assert.notEqual(frame.trim(), "");
      assert.match(frame, /❯/);
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
