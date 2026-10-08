import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { BgTaskManager } from "../src/bg-tasks/manager.js";
import { BgTaskStore, type TaskMeta, type TaskResult } from "../src/bg-tasks/store.js";
import { createBgTaskTools } from "../src/bg-tasks/tools.js";

/**
 * These tests exercise the persistence layer and tool surface without requiring
 * tmux. The tmux integration test lives in bg-tasks.integration.test.ts and is
 * skipped automatically when tmux is not on PATH.
 */

async function withTempDir(callback: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "mini-agent-bg-tasks-"));
  try {
    await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("BgTaskStore persistence", () => {
  it("creates task directories with private permissions", async () => {
    await withTempDir(async (cwd) => {
      const store = new BgTaskStore(cwd, "test-instance");
      await store.initialize();
      const paths = await store.createTask({
        schemaVersion: 1,
        taskId: "bg_00000000000000000000000000000001",
        name: "test task",
        command: "echo hi",
        cwd: process.cwd(),
        shell: "/bin/sh",
        status: "starting",
        createdAt: new Date().toISOString(),
        notifyOnCompletion: true,
      } satisfies TaskMeta);
      assert.ok(existsSync(paths.meta));
      assert.ok(existsSync(paths.log));
      assert.ok(!existsSync(paths.result));
      assert.ok(!existsSync(paths.gate));
    });
  });

  it("writes results atomically and does not overwrite existing results", async () => {
    await withTempDir(async (cwd) => {
      const store = new BgTaskStore(cwd, "test-instance");
      await store.initialize();
      const meta: TaskMeta = {
        schemaVersion: 1,
        taskId: "bg_00000000000000000000000000000002",
        name: "test",
        command: "true",
        cwd: process.cwd(),
        shell: "/bin/sh",
        status: "starting",
        createdAt: new Date().toISOString(),
        notifyOnCompletion: true,
      };
      const paths = await store.createTask(meta);

      const first: TaskResult = {
        schemaVersion: 1,
        taskId: meta.taskId,
        status: "completed",
        exitCode: 0,
        signal: null,
        endedAt: new Date().toISOString(),
      };
      const second: TaskResult = {
        schemaVersion: 1,
        taskId: meta.taskId,
        status: "failed",
        exitCode: 1,
        signal: null,
        endedAt: new Date().toISOString(),
      };

      await store.writeResult(paths, first);
      await store.writeResult(paths, second);

      const read = await store.readResult(paths);
      assert.equal(read?.status, "completed");
      assert.equal(read?.exitCode, 0);
    });
  });

  it("recovers tasks from persisted state", async () => {
    await withTempDir(async (cwd) => {
      const store = new BgTaskStore(cwd, "test-instance");
      await store.initialize();
      const meta: TaskMeta = {
        schemaVersion: 1,
        taskId: "bg_00000000000000000000000000000003",
        name: "test",
        command: "true",
        cwd: process.cwd(),
        shell: "/bin/sh",
        status: "starting",
        createdAt: new Date().toISOString(),
        notifyOnCompletion: true,
      };
      const paths = await store.createTask(meta);
      const result: TaskResult = {
        schemaVersion: 1,
        taskId: meta.taskId,
        status: "completed",
        exitCode: 0,
        signal: null,
        endedAt: new Date().toISOString(),
      };
      await store.writeResult(paths, result);

      // A second store instance (new process) should still find the task.
      const recovered = new BgTaskStore(cwd, "test-instance");
      const found = await recovered.findTask(meta.taskId);
      assert.ok(found);
      const read = await recovered.readResult(found);
      assert.equal(read?.status, "completed");
    });
  });
});

describe("BgTaskManager tool surface", () => {
  it("exposes all six background task tools", () => {
    const manager = new BgTaskManager(process.cwd(), "unit-test-instance");
    const tools = createBgTaskTools(manager);
    const names = new Set(tools.map((tool) => tool.name));
    for (const expected of ["bg_start", "bg_status", "bg_logs", "bg_send", "bg_wait", "bg_kill"]) {
      assert.ok(names.has(expected), `missing tool ${expected}`);
    }
    assert.equal(tools.length, 6);
  });

  it("bg_status reports no tasks on a clean instance", async () => {
    await withTempDir(async (cwd) => {
      const manager = new BgTaskManager(cwd, "unit-test-instance");
      const store = new BgTaskStore(cwd, "unit-test-instance");
      await store.initialize();
      const tools = createBgTaskTools(manager);
      const status = tools.find((tool) => tool.name === "bg_status")!;
      const result = await status.execute({} as Record<string, unknown>);
      const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
      assert.match(text, /No tasks/);
      manager.dispose();
    });
  });

  it("bg_logs rejects invalid limits and missing tasks", async () => {
    await withTempDir(async (cwd) => {
      const manager = new BgTaskManager(cwd, "unit-test-instance");
      const store = new BgTaskStore(cwd, "unit-test-instance");
      await store.initialize();
      const tools = createBgTaskTools(manager);
      const logs = tools.find((tool) => tool.name === "bg_logs")!;

      let rejected = false;
      try {
        await logs.execute({ taskId: "bg_does_not_exist" } as Record<string, unknown>);
      } catch (error) {
        assert.match((error as Error).message, /Task not found/);
        rejected = true;
      }
      assert.ok(rejected, "bg_logs should reject unknown task ids");
      manager.dispose();
    });
  });

  it("bg_wait rejects empty task lists", async () => {
    await withTempDir(async (cwd) => {
      const manager = new BgTaskManager(cwd, "unit-test-instance");
      const store = new BgTaskStore(cwd, "unit-test-instance");
      await store.initialize();
      const tools = createBgTaskTools(manager);
      const wait = tools.find((tool) => tool.name === "bg_wait")!;

      let rejected = false;
      try {
        await wait.execute({ taskIds: [] } as Record<string, unknown>);
      } catch (error) {
        assert.match((error as Error).message, /must not be empty/);
        rejected = true;
      }
      assert.ok(rejected);
      manager.dispose();
    });
  });
});
