/// <reference types="../ink-testing-library.d.ts" />
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { AgentDashboard } from "../src/tui/components/AgentDashboard.tsx";

let render: typeof import("ink-testing-library").render | undefined;
try {
  ({ render } = await import("ink-testing-library"));
} catch (error: unknown) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "MODULE_NOT_FOUND") throw error;
}

test("agent dashboard dispatches agents and opens a selected session", async () => {
  assert.ok(render, "ink-testing-library missing");
  const agents = [
    {
      id: "main",
      name: "Main agent",
      task: "Add a live dashboard",
      status: "Working",
      activity: "Delegating",
      active: true,
      failed: false,
      startedAt: Date.now(),
    },
    {
      id: "agent-1",
      name: "researcher",
      task: "Inspect the session mode transition",
      status: "Working",
      activity: "Read(src/tui/App.tsx)",
      active: true,
      failed: false,
      startedAt: Date.now(),
    },
  ];
  let closed = false;
  let openedAgent = "";
  const dispatches: Array<{ prompt: string; attach: boolean }> = [];
  const view = render!(React.createElement(AgentDashboard, {
    agents,
    activeAgentId: "main",
    width: 80,
    height: 12,
    onClose: () => { closed = true; },
    onDispatch: (prompt: string, attach: boolean) => dispatches.push({ prompt, attach }),
    onOpenAgent: (id: string) => { openedAgent = id; },
    worktreeIsolation: true,
    onToggleWorktreeIsolation: () => {},
  }));

  try {
    assert.match(view.lastFrame() ?? "", /Agent dashboard/);
    assert.match(view.lastFrame() ?? "", /2 active · 2 total/);
    assert.match(view.lastFrame() ?? "", /Main agent/);
    assert.match(view.lastFrame() ?? "", /Workspace: Worktree/);

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    view.stdin.write("\x1b[B");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.match(view.lastFrame() ?? "", /researcher/);

    view.stdin.write("Inspect the auth flow");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    view.stdin.write("\r");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(dispatches[0], { prompt: "Inspect the auth flow", attach: false });

    view.stdin.write("Check the tests");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    view.stdin.write("\x13");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(dispatches[1], { prompt: "Check the tests", attach: true });

    view.stdin.write("\r");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(openedAgent, "agent-1");

    view.stdin.write("\x1b");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(closed, true);
  } finally {
    view.cleanup();
  }
});
