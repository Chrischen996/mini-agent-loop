import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, before, after } from "node:test";
import { BgTaskManager } from "../src/bg-tasks/manager.js";
import { BgTaskStore } from "../src/bg-tasks/store.js";
import { createBgTaskTools } from "../src/bg-tasks/tools.js";

const execFileAsync = promisify(execFile);

let tmuxAvailable = false;

async function withTempDir(callback: (dir: string) => Promise<void>): Promise<void> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "mini-agent-bg-e2e-"));
  try {
    await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("BgTaskManager end-to-end (real tmux)", () => {
  before(async () => {
    try {
      await execFileAsync("tmux", ["-V"], { timeout: 3000 });
      tmuxAvailable = true;
    } catch {
      tmuxAvailable = false;
    }
  });

  const itOrSkip: (
    name: string,
    options: { timeout?: number },
    fn: () => void | Promise<void>,
  ) => void = tmuxAvailable ? it : (it as unknown as { skip: typeof it }).skip;
  itOrSkip("runs a real command through start → status → logs → wait → kill", { timeout: 90_000 }, async () => {
    if (!tmuxAvailable) return;

    await withTempDir(async (cwd) => {
      const instanceId = `e2e_${Date.now()}`;
      const manager = new BgTaskManager(cwd, instanceId);
      await manager.initialize();
      const tools = createBgTaskTools(manager);
      const byName = new Map(tools.map((t) => [t.name, t]));
      const startTool = byName.get("bg_start")!;
      const statusTool = byName.get("bg_status")!;
      const logsTool = byName.get("bg_logs")!;
      const waitTool = byName.get("bg_wait")!;
      const killTool = byName.get("bg_kill")!;

      // ── 1. bg_start ────────────────────────────────────────────────
      const startResult = await startTool.execute({
        command: "echo hello-bg && sleep 1 && echo done-bg",
        name: "e2e-echo",
      } as Record<string, unknown>);
      assert.match(String(startResult.content), /Started bg_/);

      // Recover the task id from a status call (the start result is a string)
      const statusAfterStart = await statusTool.execute({} as Record<string, unknown>);
      const statusText = String(statusAfterStart.content);
      const taskId = /bg_[0-9a-f]{32}/.exec(statusText)?.[0]!;
      assert.ok(taskId, `expected a task id in status output:\n${statusText}`);

      // ── 2. bg_wait until terminal ────────────────────────────────
      const waitResult = await waitTool.execute({
        taskIds: [taskId],
        mode: "all",
        timeoutSeconds: 20,
      } as Record<string, unknown>);
      const waitText = String(waitResult.content);
      assert.match(waitText, /completed/);

      // ── 3. bg_logs should contain the echoed lines ────────────────
      const logResult = await logsTool.execute({ taskId } as Record<string, unknown>);
      const logText = String(logResult.content);
      assert.match(logText, /hello-bg/);
      assert.match(logText, /done-bg/);

      // ── 4. bg_kill a long-running task ────────────────────────────
      const killStart = await startTool.execute({
        command: "sleep 60",
        name: "e2e-sleep",
      } as Record<string, unknown>);
      assert.match(String(killStart.content), /Started bg_/);

      const statusAfterSecond = await statusTool.execute({} as Record<string, unknown>);
      const sleepTaskId = [...String(statusAfterSecond.content).matchAll(/bg_[0-9a-f]{32}/g)]
        .map((m) => m[0])
        .find((id) => id !== taskId)!;
      assert.ok(sleepTaskId, "expected a second task id");

      const killResult = await killTool.execute({ taskId: sleepTaskId } as Record<string, unknown>);
      assert.match(String(killResult.content), /is cancelled/);

      const statusFinal = await statusTool.execute({ taskIds: [sleepTaskId] } as Record<string, unknown>);
      assert.match(String(statusFinal.content), /cancelled/);

      manager.dispose();

      // ── 5. verify persisted result.json on disk ──────────────────
      const store = new BgTaskStore(cwd, instanceId);
      const paths = store.paths(sleepTaskId);
      const result = await store.readResult(paths);
      assert.equal(result?.status, "cancelled");
      assert.equal(result?.exitCode, null);
      assert.equal(result?.signal, "SIGHUP");
    });
  });

  itOrSkip("honors timeoutSeconds and marks the task timed_out", { timeout: 30_000 }, async () => {
    if (!tmuxAvailable) return;

    await withTempDir(async (cwd) => {
      const instanceId = `e2e_timeout_${Date.now()}`;
      const manager = new BgTaskManager(cwd, instanceId);
      await manager.initialize();
      const tools = createBgTaskTools(manager);
      const byName = new Map(tools.map((t) => [t.name, t]));
      const startTool = byName.get("bg_start")!;
      const waitTool = byName.get("bg_wait")!;
      const statusTool = byName.get("bg_status")!;

      await startTool.execute({
        command: "sleep 30",
        name: "timeout-target",
        timeoutSeconds: 3,
      } as Record<string, unknown>);

      const status = await statusTool.execute({} as Record<string, unknown>);
      const taskId = /bg_[0-9a-f]{32}/.exec(String(status.content))?.[0]!;
      assert.ok(taskId);

      const waitResult = await waitTool.execute({
        taskIds: [taskId],
        mode: "all",
        timeoutSeconds: 15,
      } as Record<string, unknown>);
      assert.match(String(waitResult.content), /timed_out/);

      manager.dispose();
    });
  });

  after(async () => {
    // Defensive cleanup: kill any orphan sessions from this test run.
    if (!tmuxAvailable) return;
    await Promise.all(
      ["pi-bg-e2e", "pi-bg-e2e_timeout"].map((name) =>
        execFileAsync("tmux", ["kill-server", "-L", name]).then(
          () => undefined,
          () => undefined,
        ),
      ),
    );
  });
});
