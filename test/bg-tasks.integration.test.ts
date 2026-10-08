import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { BgTaskManager } from "../src/bg-tasks/manager.js";
import { BgTaskStore } from "../src/bg-tasks/store.js";
import { createBgTaskTools } from "../src/bg-tasks/tools.js";

const execFileAsync = promisify(execFile);

async function tmuxAvailable(): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["-V"], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function withTempDir(callback: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "mini-agent-bg-tasks-integration-"));
  try {
    await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("BgTaskManager tmux integration", () => {
  it("start → status → logs → kill → verify persisted result", { timeout: 60_000 }, async () => {
    if (!(await tmuxAvailable())) {
      // Auto-skip when tmux is not installed
      return;
    }

    await withTempDir(async (cwd) => {
      const manager = new BgTaskManager(cwd, "integration-test");
      await manager.initialize();

      // Start a command that prints lines for a few seconds
      const task = await manager.start({
        command: "for i in 1 2 3 4 5; do echo line-$i; sleep 0.5; done; echo done",
        name: "integration echo loop",
      });
      assert.match(task.taskId, /^bg_/);
      assert.equal(task.status, "running");

      // Poll status until the command completes (max ~15s)
      let summary: Awaited<ReturnType<typeof manager.get>> | undefined;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        summary = await manager.get(task.taskId);
        if (summary && ["completed", "failed", "cancelled", "interrupted", "timed_out"].includes(summary.status)) {
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      assert.ok(summary, "task summary should exist");
      assert.equal(summary.status, "completed");
      assert.equal(summary.exitCode, 0);

      // Read the log and verify expected content
      const logs = createBgTaskTools(manager);
      const bgLogs = logs.find((tool) => tool.name === "bg_logs")!;
      const result = await bgLogs.execute({ taskId: task.taskId } as Record<string, unknown>);
      const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
      assert.match(text, /line-1/);
      assert.match(text, /line-5/);
      assert.match(text, /done/);
      assert.match(text, /endOfLog=true/);

      // Verify the log file exists on disk
      assert.ok(existsSync(summary.logPath));

      // Now start a task we will explicitly terminate
      const killTask = await manager.start({
        command: "sleep 60",
        name: "kill test",
      });
      assert.equal(killTask.status, "running");

      const bgKill = logs.find((tool) => tool.name === "bg_kill")!;
      await bgKill.execute({ taskId: killTask.taskId } as Record<string, unknown>);

      const killed = await manager.get(killTask.taskId);
      assert.equal(killed!.status, "cancelled");

      // The result file must exist for the killed task
      const store = new BgTaskStore(cwd, "integration-test");
      const paths = store.paths(killTask.taskId);
      assert.ok(existsSync(paths.result));

      manager.dispose();
    });
  });

  it("bg_wait returns when a task completes", { timeout: 60_000 }, async () => {
    if (!(await tmuxAvailable())) return;

    await withTempDir(async (cwd) => {
      const manager = new BgTaskManager(cwd, "integration-test-wait");
      await manager.initialize();

      const task = await manager.start({
        command: "echo wait-test && sleep 1 && echo finished",
        name: "wait target",
      });

      const tools = createBgTaskTools(manager);
      const bgWait = tools.find((tool) => tool.name === "bg_wait")!;
      const result = await bgWait.execute(
        { taskIds: [task.taskId], mode: "all", timeoutSeconds: 15 } as Record<string, unknown>,
      );
      const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
      assert.match(text, /completed/);
      assert.doesNotMatch(text, /timed out/i);

      manager.dispose();
    });
  });

  it("bg_start with timeout marks task as timed_out", { timeout: 30_000 }, async () => {
    if (!(await tmuxAvailable())) return;

    await withTempDir(async (cwd) => {
      const manager = new BgTaskManager(cwd, "integration-test-timeout");
      await manager.initialize();

      const task = await manager.start({
        command: "sleep 30",
        name: "timeout target",
        timeoutSeconds: 3,
      });

      const tools = createBgTaskTools(manager);
      const bgWait = tools.find((tool) => tool.name === "bg_wait")!;
      const result = await bgWait.execute(
        { taskIds: [task.taskId], mode: "all", timeoutSeconds: 10 } as Record<string, unknown>,
      );
      const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
      assert.match(text, /timed_out/);

      const summary = await manager.get(task.taskId);
      assert.equal(summary!.status, "timed_out");

      manager.dispose();
    });
  });
});
