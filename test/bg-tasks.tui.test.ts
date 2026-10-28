/// <reference types="../ink-testing-library.d.ts" />
import assert from "node:assert/strict";
import React from "react";
import { describe, it } from "node:test";
import { render } from "ink-testing-library";
import * as slashCommands from "../src/tui/slash-commands.ts";
import { SLASH_COMMANDS, formatHelpNotice } from "../src/tui/slash-commands.ts";
import { buildStatusSegments } from "../src/tui/status-line.ts";
import { BgTaskLivePanel } from "../src/tui/components/BgTaskLivePanel.tsx";
import type { BgTaskSummary } from "../src/bg-tasks/manager.ts";

const waitForRender = () => new Promise<void>((resolve) => setTimeout(resolve, 80));

function summary(taskId: string, name: string): BgTaskSummary {
  return {
    taskId,
    name,
    command: "sleep 1",
    cwd: "/tmp",
    status: "running",
    createdAt: new Date(0).toISOString(),
  } as BgTaskSummary;
}

/** Records which task each log read targeted so the panel can be asserted on. */
function fakeManager(tasks: BgTaskSummary[], logs: Record<string, string>) {
  const offsets = new Map<string, number>();
  const calls: string[] = [];
  const terminated: string[] = [];
  return {
    calls,
    terminated,
    manager: {
      initialize: async () => {},
      list: async () => tasks,
      logs: async (taskId: string, offset = 0) => {
        calls.push(taskId);
        const full = logs[taskId] ?? "";
        const start = Math.min(offset, full.length);
        const text = full.slice(start);
        offsets.set(taskId, full.length);
        void offsets;
        return { taskId, text, offset: start, nextOffset: full.length, endOfLog: true };
      },
      terminate: async (taskId: string) => {
        terminated.push(taskId);
        const task = tasks.find((entry) => entry.taskId === taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);
        return task;
      },
    },
  };
}

const parseBackgroundTaskCommand = (slashCommands as unknown as {
  parseBackgroundTaskCommand?: (input: string) => unknown;
}).parseBackgroundTaskCommand;

describe("bg-tasks TUI surface", () => {
  it("preserves the full input text when parsing a send command", () => {
    assert.equal(typeof parseBackgroundTaskCommand, "function");
    assert.deepEqual(parseBackgroundTaskCommand!("/bg-tasks bg_123 send print('hello there')"), {
      kind: "send",
      reference: "bg_123",
      text: "print('hello there')",
    });
  });

  it("registers /bg-tasks in the slash command catalog", () => {
    const command = SLASH_COMMANDS.find((entry) => entry.name === "bg-tasks");
    assert.ok(command);
    assert.equal(command!.usage, "/bg-tasks");
    assert.match(command!.description, /background task/i);
  });

  it("registers the task dashboard command and lists it in help", () => {
    const command = SLASH_COMMANDS.find((entry) => entry.name === "dashboard");
    assert.ok(command);
    assert.equal(command!.usage, "/dashboard");
    assert.match(command!.description, /background task/i);
    assert.match(formatHelpNotice(), /\/dashboard/);
  });

  it("lists /bg-tasks in the help notice", () => {
    const help = formatHelpNotice();
    assert.match(help, /\/bg-tasks/);
  });

  it("keeps status segments free of a background-task segment by default", () => {
    const segments = buildStatusSegments({
      modelName: "model",
      permissionMode: "plan",
      contextTokens: 0,
      busy: false,
    });
    assert.ok(!segments.some((segment) => segment.text.includes("bg task")));
  });

  describe("BgTaskLivePanel", () => {
    it("summarizes multiple tasks and stops the selected running task with x", async () => {
      const { manager, terminated } = fakeManager(
        [summary("bg_aaaa1111", "build"), { ...summary("bg_bbbb2222", "lint"), status: "completed" }],
        {},
      );
      const view = render(React.createElement(BgTaskLivePanel, { manager, width: 70 }), { columns: 100, rows: 40 });
      try {
        await waitForRender();
        const frame = view.lastFrame() ?? "";
        assert.match(frame, /Background task dashboard/i);
        assert.match(frame, /1 running/);
        assert.match(frame, /1 finished/);
        assert.match(frame, /x stop/);

        view.stdin.write("x");
        await waitForRender();
        assert.deepEqual(terminated, ["bg_aaaa1111"]);
      } finally {
        view.cleanup();
      }
    });

    it("shows the selected task's log without splicing in another task's output", async () => {
      const { manager } = fakeManager(
        [summary("bg_aaaa1111", "build"), summary("bg_bbbb2222", "lint")],
        { bg_aaaa1111: "alpha-output\n", bg_bbbb2222: "beta-output\n" },
      );
      const view = render(React.createElement(BgTaskLivePanel, { manager, width: 70 }), { columns: 100, rows: 40 });
      try {
        await waitForRender();
        const first = view.lastFrame() ?? "";
        assert.match(first, /alpha-output/);
        assert.ok(!first.includes("beta-output"), "second task's log must not appear before selection");

        view.stdin.write("\x1b[B");
        await waitForRender();
        const second = view.lastFrame() ?? "";
        assert.match(second, /beta-output/);
        assert.ok(!second.includes("alpha-output"), "stale log from the previous task must be cleared");
      } finally {
        view.cleanup();
      }
    });

    it("targets the newly selected task when reading logs", async () => {
      const { manager, calls } = fakeManager(
        [summary("bg_aaaa1111", "build"), summary("bg_bbbb2222", "lint")],
        { bg_aaaa1111: "alpha\n", bg_bbbb2222: "beta\n" },
      );
      const view = render(React.createElement(BgTaskLivePanel, { manager, width: 70 }), { columns: 100, rows: 40 });
      try {
        await waitForRender();
        view.stdin.write("\x1b[B");
        await waitForRender();
        assert.equal(calls.at(-1), "bg_bbbb2222");
      } finally {
        view.cleanup();
      }
    });
  });
});
