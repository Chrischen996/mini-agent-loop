import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SubagentTaskRegistry } from "../src/subagent/task-registry.ts";
import { launchDetachedSubagentWorker } from "../src/subagent/worker-host.ts";

describe("detached sub-agent worker host", () => {
  it("persists the worker PID before releasing the child and returns without waiting for its work", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mini-agent-worker-host-"));
    const markerPath = join(workspace, "started.json");
    const workerPath = join(workspace, "worker.mjs");
    const taskId = "sub_40000000-0000-4000-8000-000000000001";
    try {
      await writeFile(workerPath, [
        'import { readFile, writeFile } from "node:fs/promises";',
        'process.once("message", async (message) => {',
        '  if (message !== "start") process.exit(2);',
        '  const record = JSON.parse(await readFile(process.env.TASK_RECORD_PATH, "utf8"));',
        '  await new Promise((resolve) => setTimeout(resolve, 500));',
        '  await writeFile(process.env.WORKER_MARKER_PATH, JSON.stringify({ pid: process.pid, storedPid: record.workerPid }));',
        '  process.exit(0);',
        '});',
      ].join("\n"));

      const registry = new SubagentTaskRegistry(workspace);
      const now = new Date().toISOString();
      await registry.start({
        taskId,
        ownerSessionId: "session-a",
        task: "verify detached startup",
        args: { task: "verify detached startup" },
        status: "queued",
        runInBackground: true,
        createdAt: now,
        startedAt: now,
        killed: false,
        blockWaited: false,
        completionConsumed: false,
        wakeDelivered: false,
      });
      const recordPath = join(workspace, ".subagent-tasks", `${taskId}.json`);
      await launchDetachedSubagentWorker({
        entryPoint: workerPath,
        cwd: workspace,
        execArgv: [],
        env: {
          ...process.env,
          TASK_RECORD_PATH: recordPath,
          WORKER_MARKER_PATH: markerPath,
        },
        taskId,
        registry,
      });
      await registry.detach(taskId);
      await assert.rejects(access(markerPath));

      let marker: { pid: number; storedPid: number } | undefined;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          marker = JSON.parse(await readFile(markerPath, "utf8")) as typeof marker;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      assert.ok(marker, "worker should finish its delayed startup check");
      assert.equal(marker.storedPid, marker.pid);
      assert.equal((await registry.get(taskId, "session-a"))?.workerPid, marker.pid);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
