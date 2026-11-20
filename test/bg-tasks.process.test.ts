import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { BgTaskManager } from "../src/bg-tasks/manager.js";

async function withTempDir(callback: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "mini-agent-bg-process-"));
  try {
    await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type ManagerInternals = {
  checkTaskHealth(): Promise<void>;
  processCompletion(taskId: string): Promise<void>;
};

describe("process background-task backend", () => {
  it("runs, persists, logs, and recovers a detached task without tmux", async () => {
    await withTempDir(async (cwd) => {
      const first = new BgTaskManager(cwd, "process-test", undefined, { backend: "process" });
      await first.initialize();
      const started = await first.start({ command: "sleep 0.2; printf process-ok" });
      assert.equal(started.backend, "process");
      assert.ok(started.pid);
      first.dispose();

      const recovered = new BgTaskManager(cwd, "process-test", undefined, { backend: "process" });
      await recovered.initialize();
      const result = await recovered.wait([started.taskId], "all", 10);
      assert.equal(result.timedOut, false);
      assert.equal(result.completed[0]?.status, "completed");
      const logs = await recovered.logs(started.taskId);
      assert.match(logs.text, /process-ok/);
      recovered.dispose();
    });
  });

  it("terminates a running detached task", async () => {
    await withTempDir(async (cwd) => {
      const manager = new BgTaskManager(cwd, "process-kill-test", undefined, { backend: "process" });
      await manager.initialize();
      const started = await manager.start({ command: "sleep 30" });
      const stopped = await manager.terminate(started.taskId);
      assert.equal(stopped.status, "cancelled");
      manager.dispose();
    });
  });

  it("syncs settled status into meta and keeps the health check off settled tasks", async () => {
    await withTempDir(async (cwd) => {
      const manager = new BgTaskManager(cwd, "process-meta-test", undefined, { backend: "process" });
      await manager.initialize();
      const started = await manager.start({ command: "printf done" });
      const result = await manager.wait([started.taskId], "all", 10);
      assert.equal(result.completed[0]?.status, "completed");
      const internals = manager as unknown as ManagerInternals;
      await internals.processCompletion(started.taskId);
      const metaPath = manager.store.paths(started.taskId).meta;
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as { status: string };
      assert.equal(meta.status, "completed");
      // The runner pid is dead by now; the health check must not relabel the
      // settled task as crashed.
      await internals.checkTaskHealth();
      const metaAfter = JSON.parse(await readFile(metaPath, "utf8")) as { status: string };
      assert.equal(metaAfter.status, "completed");
      manager.dispose();
    });
  });

  it("removes stale tmp files at startup but keeps recent ones", async () => {
    await withTempDir(async (cwd) => {
      const instanceId = "process-cleanup-test";
      const taskId = "bg_cleanup00000000000000000000000000000001";
      const taskDir = path.join(cwd, ".bg-tasks", "instances", instanceId, taskId);
      await mkdir(taskDir, { recursive: true });
      await writeFile(path.join(taskDir, "meta.json"), "{}\n");
      const stale = path.join(taskDir, "meta.json.12345.1.tmp");
      await writeFile(stale, "{}\n");
      const old = new Date(Date.now() - 11 * 60 * 1000);
      await utimes(stale, old, old);
      const fresh = path.join(taskDir, "meta.json.12345.2.tmp");
      await writeFile(fresh, "{}\n");

      const manager = new BgTaskManager(cwd, instanceId, undefined, { backend: "process" });
      await manager.initialize();
      assert.equal(existsSync(stale), false, "stale tmp file should be removed");
      assert.equal(existsSync(fresh), true, "recent tmp file should be kept");
      manager.dispose();
    });
  });
});
