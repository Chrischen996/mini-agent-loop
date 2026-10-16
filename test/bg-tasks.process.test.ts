import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
});
