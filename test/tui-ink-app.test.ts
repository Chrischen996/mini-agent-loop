/// <reference types="../ink-testing-library.d.ts" />
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import React, { useState } from "react";
import { App } from "../src/tui/App.tsx";
import { PromptInput } from "../src/tui/components/PromptInput.tsx";
import { stableBgTaskInstanceId } from "../src/bg-tasks/manager.js";
import { BgTaskStore } from "../src/bg-tasks/store.js";
import { SessionManager } from "../src/session-manager.ts";

let render: typeof import("ink-testing-library").render | undefined;
try {
  ({ render } = await import("ink-testing-library"));
} catch (error: unknown) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "MODULE_NOT_FOUND") throw error;
}

const waitForRender = () => new Promise<void>((resolve) => setTimeout(resolve, 60));

// Keep this suite offline and separate from a developer's saved profiles or
// sessions. The fake key is never sent to a provider: these are local commands.
const overrides = {
  AGENT_DATA_DIR: "",
  MINI_AGENT_WORKTREE_DIR: "",
  MINI_AGENT_UPDATE_CHECK: "0",
  OPENAI_MODEL: "openai/gpt-4o",
  OPENAI_API_KEY: "not-a-real-key",
  TUI_CLAUDE_STYLE_INPUT: "1",
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
      process.env[name] = name === "AGENT_DATA_DIR" ? cwd
        : name === "MINI_AGENT_WORKTREE_DIR" ? path.join(cwd, "worktrees")
          : value;
    }
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  function open(
    dimensions: { columns?: number; rows?: number } = {},
    startupSessionRequest?: { sessionId?: string; resume: boolean; continueSession: boolean; fork: boolean },
    appOverrides: Partial<React.ComponentProps<typeof App>> = {},
  ) {
    return render!(React.createElement(App, { cwd, agentTools: [], allTools: [], startupSessionRequest, worktreeIsolation: false, ...appOverrides }), dimensions);
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

  it("recalculates the fixed viewport when the terminal is resized", async () => {
    const view = open();
    const stdout = (view as unknown as {
      stdout: { rows?: number; emit: (event: string) => boolean };
    }).stdout;
    try {
      await waitForRender();
      const initialRows = (view.lastFrame() ?? "").split("\n").length;

      stdout.rows = 14;
      stdout.emit("resize");
      await waitForRender();

      const resizedFrame = view.lastFrame() ?? "";
      const resizedRows = resizedFrame.split("\n").length;
      assert.ok(resizedRows < initialRows, `expected viewport to shrink from ${initialRows} rows, got ${resizedRows}`);
      assert.match(resizedFrame, /^ >/m);
      assert.match(resizedFrame, /Ready/);
    } finally {
      view.cleanup();
    }
  });

  it("opens the agent dashboard locally and returns to the same conversation", async () => {
    const view = open();
    try {
      await submit(view, "/dashboard");
      const dashboard = view.lastFrame() ?? "";
      assert.match(dashboard, /Agent dashboard/);
      assert.match(dashboard, /Main agent/);
      assert.doesNotMatch(dashboard, /Working…/);

      view.stdin.write("\x1b");
      await waitForRender();
      const conversation = view.lastFrame() ?? "";
      assert.doesNotMatch(conversation, /Agent dashboard/);
      assert.match(conversation, />/);
    } finally {
      view.cleanup();
    }
  });

  it("toggles dashboard worktree isolation without dispatching a task", async () => {
    const view = open({}, undefined, { worktreeIsolation: true });
    try {
      await submit(view, "/dashboard");
      assert.match(view.lastFrame() ?? "", /Workspace: Worktree/);

      await submit(view, "/worktree");
      const dashboard = view.lastFrame() ?? "";
      assert.match(dashboard, /Workspace: Shared/);
      assert.doesNotMatch(dashboard, /Agent 2/);
    } finally {
      view.cleanup();
    }
  });

  it("dispatches a new independent session while leaving the dashboard open", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ messages?: Array<{ role: string; content?: string }> }> = [];
    globalThis.fetch = (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content?: string }> });
      const payload = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "new agent session result" }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
        "data: [DONE]",
        "",
      ].join("\n\n");
      return new Response(payload, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const view = open();
    try {
      await submit(view, "/dashboard");
      view.stdin.write("Inspect the login flow");
      await waitForRender();
      view.stdin.write("\r");

      for (let attempt = 0; attempt < 20 && !((view.lastFrame() ?? "").includes("Completed") && requests.length > 0); attempt += 1) {
        await waitForRender();
      }

      const dashboard = view.lastFrame() ?? "";
      assert.match(dashboard, /Agent dashboard/);
      assert.match(dashboard, /Inspect the login flow/);
      assert.match(dashboard, /Completed/);
      assert.equal(requests.length, 1);
      assert.ok(requests[0]?.messages?.some((message) => message.role === "user" && message.content === "Inspect the login flow"));

      view.stdin.write("\x1b[A");
      await waitForRender();
      view.stdin.write("\r");
      await waitForRender();
      assert.match(view.lastFrame() ?? "", /new agent session result/);
    } finally {
      view.cleanup();
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps dashboard-dispatched sessions running concurrently", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ messages?: Array<{ role: string; content?: string }> }> = [];
    const resolvers: Array<(response: Response) => void> = [];
    globalThis.fetch = (( _input, init) => {
      requests.push(JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content?: string }> });
      return new Promise<Response>((resolve) => resolvers.push(resolve));
    }) as typeof fetch;

    const complete = (text: string) => new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
      "",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });

    const view = open();
    try {
      await submit(view, "/dashboard");
      view.stdin.write("First independent task");
      await waitForRender();
      view.stdin.write("\r");
      for (let attempt = 0; attempt < 20 && requests.length < 1; attempt += 1) await waitForRender();

      view.stdin.write("Second independent task");
      await waitForRender();
      view.stdin.write("\r");
      for (let attempt = 0; attempt < 20 && requests.length < 2; attempt += 1) await waitForRender();

      assert.equal(requests.length, 2, "both dispatched sessions should reach the provider before either completes");
      assert.match(view.lastFrame() ?? "", /2 active · 3 total/);
      assert.ok(requests[0]?.messages?.some((message) => message.role === "user" && message.content === "First independent task"));
      assert.ok(requests[1]?.messages?.some((message) => message.role === "user" && message.content === "Second independent task"));

      resolvers[0]?.(complete("first result"));
      resolvers[1]?.(complete("second result"));
      for (let attempt = 0; attempt < 20 && !(view.lastFrame() ?? "").includes("0 active · 3 total"); attempt += 1) await waitForRender();
      assert.match(view.lastFrame() ?? "", /0 active · 3 total/);

      const savedSessions = await new SessionManager({ workspaceId: cwd }).list();
      const taskSessions = savedSessions.filter((session) =>
        session.preview === "First independent task" || session.preview === "Second independent task",
      );
      assert.equal(taskSessions.length, 2, "each dispatched agent should persist to its own session");
      assert.notEqual(taskSessions[0]?.id, taskSessions[1]?.id);
    } finally {
      for (const resolve of resolvers) resolve(complete("test cleanup"));
      view.cleanup();
      globalThis.fetch = originalFetch;
    }
  });

  it("starts dashboard agents in their own worktree and persists that cwd", async () => {
    const originalFetch = globalThis.fetch;
    const project = path.join(cwd, "project");
    mkdirSync(project);
    execFileSync("git", ["init", "-q"], { cwd: project });
    execFileSync("git", ["config", "user.name", "mini-agent"], { cwd: project });
    execFileSync("git", ["config", "user.email", "mini-agent@example.invalid"], { cwd: project });
    writeFileSync(path.join(project, "base.txt"), "committed baseline\n");
    execFileSync("git", ["add", "base.txt"], { cwd: project });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: project });
    const requests: Array<{ messages?: Array<{ role: string; content?: string }> }> = [];
    globalThis.fetch = (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content?: string }> });
      const payload = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "isolated result" }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
        "data: [DONE]",
        "",
      ].join("\n\n");
      return new Response(payload, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const providerCwds: string[] = [];
    let createdWorktreeCwd: string | undefined;
    let savedSessionId: string | undefined;
    const cwdProvider = (workspaceCwd: string) => {
      providerCwds.push(workspaceCwd);
      return [];
    };
    const view = open({}, undefined, {
      cwd: project,
      worktreeIsolation: true,
      agentToolsForCwd: cwdProvider,
      allToolsForCwd: cwdProvider,
    });

    try {
      await submit(view, "/dashboard");
      view.stdin.write("Inspect the auth flow");
      await waitForRender();
      view.stdin.write("\r");
      for (let attempt = 0; attempt < 30 && !(view.lastFrame() ?? "").includes("Completed"); attempt += 1) {
        await waitForRender();
      }

      const worktreeCwd = providerCwds.find((workspaceCwd) => workspaceCwd !== project);
      assert.ok(worktreeCwd, "the dispatched agent should receive a worktree-specific tool provider");
      createdWorktreeCwd = worktreeCwd;
      assert.equal(readFileSync(path.join(project, "base.txt"), "utf8"), "committed baseline\n");
      assert.match(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: project, encoding: "utf8" }), new RegExp(worktreeCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(requests.length, 1);
      assert.ok(requests[0]?.messages?.some((message) => message.role === "user" && message.content === "Inspect the auth flow"));

      const manager = new SessionManager({ workspaceId: project });
      const sessions = await manager.list();
      assert.equal(sessions.length, 1);
      savedSessionId = sessions[0]!.id;
      const session = await manager.load(sessions[0]!.id);
      assert.equal(session?.cwd, worktreeCwd);
      assert.equal(session?.workspaceId, project);
    } finally {
      view.cleanup();
      globalThis.fetch = originalFetch;
    }

    assert.ok(createdWorktreeCwd);
    assert.ok(savedSessionId);
    const canonicalWorktreeCwd = realpathSync(createdWorktreeCwd);
    const resumedProviderCwds: string[] = [];
    const resumedProvider = (workspaceCwd: string) => {
      resumedProviderCwds.push(workspaceCwd);
      return [];
    };
    const resumedView = open({}, {
      sessionId: savedSessionId,
      resume: true,
      continueSession: false,
      fork: false,
    }, {
      cwd: project,
      worktreeIsolation: false,
      agentToolsForCwd: resumedProvider,
      allToolsForCwd: resumedProvider,
    });
    try {
      for (let attempt = 0; attempt < 20 && !((resumedView.lastFrame() ?? "").includes("Inspect the auth flow")); attempt += 1) {
        await waitForRender();
      }
      assert.ok(resumedProviderCwds.includes(canonicalWorktreeCwd), "resuming should restore the persisted worktree cwd");
      assert.match(resumedView.lastFrame() ?? "", /Inspect the auth flow/);
    } finally {
      resumedView.cleanup();
    }
  });

  it("sequentially restores sessions from different worktrees", async () => {
    const project = path.join(cwd, "resume-project");
    const worktreeA = path.join(cwd, "resume-worktrees", "a");
    const worktreeB = path.join(cwd, "resume-worktrees", "b");
    mkdirSync(project);
    mkdirSync(path.dirname(worktreeA), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: project });
    execFileSync("git", ["config", "user.name", "mini-agent"], { cwd: project });
    execFileSync("git", ["config", "user.email", "mini-agent@example.invalid"], { cwd: project });
    writeFileSync(path.join(project, "base.txt"), "baseline\n");
    execFileSync("git", ["add", "base.txt"], { cwd: project });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: project });
    execFileSync("git", ["worktree", "add", "-qb", "test/resume-a", worktreeA], { cwd: project });
    execFileSync("git", ["worktree", "add", "-qb", "test/resume-b", worktreeB], { cwd: project });

    const canonicalA = realpathSync(worktreeA);
    const canonicalB = realpathSync(worktreeB);
    const manager = new SessionManager({ workspaceId: project });
    await manager.save({
      id: "resume-worktree-a",
      cwd: canonicalA,
      messages: [{ role: "user", content: "session from worktree A" }],
    });
    await manager.save({
      id: "resume-worktree-b",
      cwd: canonicalB,
      messages: [{ role: "user", content: "session from worktree B" }],
    });

    const providerCwds: string[] = [];
    const systemPromptContext = {};
    const view = open({}, {
      sessionId: "resume-worktree-a",
      resume: true,
      continueSession: false,
      fork: false,
    }, {
      cwd: project,
      systemPromptContext,
      agentToolsForCwd: (workspaceCwd) => {
        providerCwds.push(workspaceCwd);
        return [];
      },
      allToolsForCwd: () => [],
    });

    const waitForProviderCwd = async (target: string, afterIndex: number): Promise<void> => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (providerCwds.slice(afterIndex).includes(target)) return;
        await waitForRender();
      }
      assert.fail(`tool provider was not rebound to ${target}; received ${providerCwds.join(", ")}`);
    };

    try {
      await waitForProviderCwd(canonicalA, 0);
      let providerIndex = providerCwds.length;
      await submit(view, "/resume resume-worktree-b");
      await waitForProviderCwd(canonicalB, providerIndex);

      providerIndex = providerCwds.length;
      await submit(view, "/resume resume-worktree-a");
      await waitForProviderCwd(canonicalA, providerIndex);
      assert.match(view.lastFrame() ?? "", /session from worktree A/);
    } finally {
      view.cleanup();
    }
  });

  it("does not silently share a dirty checkout when worktree creation fails", async () => {
    const project = path.join(cwd, "dirty-project");
    mkdirSync(project);
    execFileSync("git", ["init", "-q"], { cwd: project });
    execFileSync("git", ["config", "user.name", "mini-agent"], { cwd: project });
    execFileSync("git", ["config", "user.email", "mini-agent@example.invalid"], { cwd: project });
    writeFileSync(path.join(project, "tracked.txt"), "baseline\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: project });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: project });
    writeFileSync(path.join(project, "tracked.txt"), "uncommitted change\n");
    const providerCwds: string[] = [];
    const view = open({}, undefined, {
      cwd: project,
      worktreeIsolation: true,
      agentToolsForCwd: (workspaceCwd) => { providerCwds.push(workspaceCwd); return []; },
      allToolsForCwd: () => [],
    });

    try {
      await submit(view, "/dashboard");
      view.stdin.write("Inspect this change");
      await waitForRender();
      view.stdin.write("\r");
      for (let attempt = 0; attempt < 20 && !(view.lastFrame() ?? "").includes("Failed"); attempt += 1) {
        await waitForRender();
      }
      view.stdin.write("\x1b[A");
      await waitForRender();
      assert.match(view.lastFrame() ?? "", /Create an isolated branch only from a clean worktree/);
      assert.ok(providerCwds.length > 0);
      assert.ok(providerCwds.every((workspaceCwd) => workspaceCwd === project));
    } finally {
      view.cleanup();
    }
  });

  it("opens the dashboard from the top-right header shortcut", async () => {
    const view = open();
    try {
      await waitForRender();
      const headerLine = (view.lastFrame() ?? "").split("\n").find((line) => line.includes("Dashboard"));
      assert.ok(headerLine, "the header should show the dashboard button");
      assert.ok(headerLine.trimEnd().endsWith("▣ Dashboard Ctrl+\\"), "the dashboard button should sit at the right edge and show Grok Build's shortcut");

      view.stdin.write("\u001c");
      await waitForRender();
      assert.match(view.lastFrame() ?? "", /Agent dashboard/);
    } finally {
      view.cleanup();
    }
  });

  it("animates PageUp through intermediate transcript rows", async () => {
    const view = open({ rows: 20 });
    const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    try {
      await submit(view, "/help");
      await submit(view, "/help");
      const before = view.lastFrame() ?? "";

      view.stdin.write("\x1b[5~");
      await wait(40);
      const moving = view.lastFrame() ?? "";
      await wait(180);
      const settled = view.lastFrame() ?? "";

      assert.notEqual(moving, before, "PageUp should render an intermediate scroll position");
      assert.notEqual(moving, settled, "the intermediate frame should differ from the settled viewport");
      assert.notEqual(settled, before, "PageUp should move the transcript viewport");
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

  it("opens a selectable background task panel and its action menu", async () => {
    const instanceId = stableBgTaskInstanceId(cwd);
    const store = new BgTaskStore(cwd, instanceId);
    await store.initialize();
    const taskId = "bg_tui_fixture";
    const paths = await store.createTask({
      schemaVersion: 1,
      taskId,
      name: "fixture task",
      command: "echo fixture",
      cwd,
      shell: process.env.ComSpec ?? "cmd.exe",
      status: "running",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      notifyOnCompletion: true,
      backend: "process",
      instanceId,
    });
    await store.writeResult(paths, {
      schemaVersion: 1,
      taskId,
      status: "completed",
      exitCode: 0,
      signal: null,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });

    const view = open();
    try {
      await submit(view, "/bg-tasks");
      assert.match(view.lastFrame() ?? "", /fixture task/);
      assert.match(view.lastFrame() ?? "", /Select a task/);

      view.stdin.write("\r");
      await waitForRender();
      const frame = view.lastFrame() ?? "";
      assert.match(frame, /View recent logs/);
      assert.match(frame, /Capture screen/);
      assert.match(frame, /Send input/);
      assert.match(frame, /Wait for completion/);
      assert.match(frame, /Terminate task/);
    } finally {
      view.cleanup();
    }
  });

  it("shows MCP overview and selected server status without starting an agent turn", async () => {
    let mcpToolReads = 0;
    const view = open({}, undefined, {
      mcpStatuses: () => [{
        id: "docs",
        transport: "http",
        required: false,
        state: "ready",
        toolCount: 1,
      }],
      mcpTools: () => {
        mcpToolReads += 1;
        return [{
          name: "mcp__docs__search",
          description: "Search docs",
          source: { kind: "mcp", serverId: "docs", toolName: "search" },
          parameters: { type: "object" },
          execute: async () => ({ content: "unused" }),
        }];
      },
    });
    try {
      await submit(view, "/mcp");
      assert.match(view.lastFrame() ?? "", /MCP servers \(1\)/);
      assert.match(view.lastFrame() ?? "", /Transport: http/);
      assert.doesNotMatch(view.lastFrame() ?? "", /Working…/);

      await submit(view, "/mcp docs");
      assert.equal(mcpToolReads, 1, `MCP tool reader should run only for server details`);
      assert.match(view.lastFrame() ?? "", /MCP server: docs/);
      assert.match(view.lastFrame() ?? "", /docs  ready/);
    } finally {
      view.cleanup();
    }
  });

  it("opens a changed-file picker and shows the selected Git diff", async () => {
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["config", "user.name", "TUI test"], { cwd });
    execFileSync("git", ["config", "user.email", "tui-test@example.invalid"], { cwd });
    const trackedFile = path.join(cwd, "tracked.txt");
    writeFileSync(trackedFile, "before\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd });
    writeFileSync(trackedFile, "before\nafter\n");

    const view = open();
    try {
      await submit(view, "/diff");
      assert.match(view.lastFrame() ?? "", /tracked\.txt/);
      assert.match(view.lastFrame() ?? "", /Select a changed file/);

      view.stdin.write("\r");
      await waitForRender();
      assert.match(view.lastFrame() ?? "", /\+after/);
      assert.match(view.lastFrame() ?? "", /diff --git a\/tracked\.txt b\/tracked\.txt/);
    } finally {
      view.cleanup();
    }
  });

  it("recalls submitted prompts with Up and restores the draft with Down", async () => {
    const view = open();
    const submittedPrompt = "/deploy history-recall-marker";
    try {
      await submit(view, submittedPrompt);
      view.stdin.write("\x1b[A");
      await waitForRender();
      assert.ok((view.lastFrame() ?? "").includes(submittedPrompt));

      view.stdin.write("\x1b[B");
      await waitForRender();
      assert.ok(!(view.lastFrame() ?? "").includes(submittedPrompt));
    } finally {
      view.cleanup();
    }
  });

  it("keeps conversation context when Shift+Tab changes permission mode", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ messages?: Array<{ role: string; content?: string }> }> = [];
    globalThis.fetch = (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content?: string }> });
      const answer = requests.length === 1 ? "first answer context marker" : "second answer";
      const payload = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
        "data: [DONE]",
        "",
      ].join("\n\n");
      return new Response(payload, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const view = open();
    try {
      await submit(view, "remember permission switch context marker");
      for (let attempt = 0; attempt < 20 && !(view.lastFrame() ?? "").includes("first answer context marker"); attempt += 1) {
        await waitForRender();
      }

      view.stdin.write("\x1b[Z");
      await waitForRender();
      await submit(view, "continue after permission switch");
      for (let attempt = 0; attempt < 20 && !(view.lastFrame() ?? "").includes("second answer"); attempt += 1) {
        await waitForRender();
      }

      const messages = requests[1]?.messages ?? [];
      assert.ok(messages.some((message) => message.role === "user" && message.content === "remember permission switch context marker"));
      assert.ok(messages.some((message) => message.role === "assistant" && message.content === "first answer context marker"));
      const system = messages.find((message) => message.role === "system");
      assert.match(system?.content ?? "", /mode=bypass/);
      assert.doesNotMatch(system?.content ?? "", /mode=plan/);
    } finally {
      view.cleanup();
      globalThis.fetch = originalFetch;
    }
  });

  it("saves a turn and restores its transcript on the next TUI launch", async () => {
    const originalFetch = globalThis.fetch;
    const payload = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Round trip answer" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    globalThis.fetch = (async () => new Response(payload, {
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;

    let view: ReturnType<typeof open> | undefined = open();
    try {
      await submit(view, "remember this TUI conversation");
      const manager = new SessionManager({ workspaceId: cwd });
      let saved = await manager.loadMostRecent();
      for (let attempt = 0; attempt < 12 && !saved?.messages.some((message) => message.role === "assistant"); attempt += 1) {
        await waitForRender();
        saved = await manager.loadMostRecent();
      }
      assert.ok(saved, "turn should create a persisted session");
      assert.ok(saved.messages.some((message) => message.role === "user" && message.content === "remember this TUI conversation"));
      assert.ok(saved.messages.some((message) => message.role === "assistant" && message.content === "Round trip answer"));

      await submit(view, `/resume ${saved.id}`);
      for (let attempt = 0; attempt < 12 && !(view.lastFrame() ?? "").includes("Round trip answer"); attempt += 1) {
        await waitForRender();
      }
      assert.match(view.lastFrame() ?? "", /Round trip answer/);

      await submit(view, "/resume");
      await waitForRender();
      view.stdin.write("\r");
      await waitForRender();
      assert.match(view.lastFrame() ?? "", /Round trip answer/);

      view.cleanup();
      view = open({}, { resume: true, continueSession: true, fork: false });
      for (let attempt = 0; attempt < 12 && !(view.lastFrame() ?? "").includes("Round trip answer"); attempt += 1) {
        await waitForRender();
      }
      const restoredFrame = view.lastFrame() ?? "";
      assert.match(restoredFrame, /remember this TUI conversation/);
      assert.match(restoredFrame, /Round trip answer/);
    } finally {
      view?.cleanup();
      globalThis.fetch = originalFetch;
    }
  });

  it("/init --print previews the deterministic template without the model or a write", async () => {
    const view = open();
    try {
      await submit(view, "/init --print");
      const frame = view.lastFrame() ?? "";
      assert.match(frame, /AGENT\.MD Template Preview/);
      // The print path must stay model-free and write-free.
      assert.doesNotMatch(frame, /Working…/);
      assert.equal(existsSync(path.join(cwd, "AGENT.MD")), false);
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
