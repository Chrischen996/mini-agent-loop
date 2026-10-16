import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import express from "express";
import request from "supertest";
import { registerBackgroundTaskRoutes, type BackgroundTaskManagerLike } from "../src/server/routes/background-tasks.ts";
import type { BgTaskSummary, LogChunk, WaitResult } from "../src/bg-tasks/manager.js";

function task(id = "bg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"): BgTaskSummary {
  return {
    taskId: id,
    name: "demo",
    command: "printf demo",
    cwd: "/tmp/project",
    status: "running",
    createdAt: new Date(0).toISOString(),
    durationMs: 0,
    exitCode: null,
    signal: null,
    ownedByCurrentInstance: true,
    sessionName: `pi-${id}`,
    socketName: "pi-bg-test",
    logPath: "/tmp/project/.bg-tasks/output.log",
    backend: "process",
  };
}

function fakeManager(): BackgroundTaskManagerLike & { calls: string[] } {
  const calls: string[] = [];
  const manager: BackgroundTaskManagerLike = {
    async list() { calls.push("list"); return [task()]; },
    async start(input) { calls.push(`start:${input.command}`); return task(); },
    async get(taskId) { calls.push(`get:${taskId}`); return task(taskId); },
    async logs(taskId, offset, limitBytes): Promise<LogChunk> {
      calls.push(`logs:${taskId}:${offset}:${limitBytes}`);
      return { taskId, text: "demo\n", offset: offset ?? 0, nextOffset: 5, endOfLog: true };
    },
    async screen(taskId) {
      calls.push(`screen:${taskId}`);
      return { taskId, text: "screen", offset: 0, nextOffset: 6, endOfLog: true };
    },
    async send(taskId) { calls.push(`send:${taskId}`); return task(taskId); },
    async terminate(taskId) { calls.push(`kill:${taskId}`); return task(taskId); },
    async wait(taskIds): Promise<WaitResult> {
      calls.push(`wait:${taskIds.join(",")}`);
      return { mode: "all", completed: taskIds.map((id) => task(id)), pending: [], timedOut: false };
    },
  };
  return Object.assign(manager, { calls });
}

describe("background task HTTP routes", () => {
  it("starts, lists, reads, waits, sends, and kills through one workspace runtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-bg-routes-"));
    await mkdir(path.join(root, "child"));
    const manager = fakeManager();
    const app = express();
    app.use(express.json());
    registerBackgroundTaskRoutes(app, {
      workspace: root,
      enabled: true,
      getRuntime: (selectedRoot) => selectedRoot === root ? { manager, initialize: async () => {} } : undefined,
      getSession: (id) => id === "session" ? { workspaceId: "workspace", cwd: root } : undefined,
      getWorkspace: (id) => id === "workspace" ? { id, name: "project", path: root } : undefined,
    });
    try {
      assert.equal((await request(app).get("/api/background-tasks")).status, 200);
      assert.equal((await request(app).post("/api/background-tasks").send({ sessionId: "session", command: "printf demo" })).status, 202);
      assert.equal((await request(app).get("/api/background-tasks/bg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/logs")).status, 200);
      assert.equal((await request(app).post("/api/background-tasks/wait").send({ taskIds: ["bg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] })).status, 200);
      assert.equal((await request(app).post("/api/background-tasks/bg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/input").send({ enter: true })).status, 200);
      assert.equal((await request(app).post("/api/background-tasks/bg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/kill")).status, 200);
      assert.ok(manager.calls.some((call) => call.startsWith("start:")));
      assert.ok(manager.calls.includes("wait:bg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects disabled, mismatched, escaping, and malformed task requests", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-bg-routes-errors-"));
    const manager = fakeManager();
    const app = express();
    app.use(express.json());
    registerBackgroundTaskRoutes(app, {
      workspace: root,
      enabled: true,
      getRuntime: () => ({ manager, initialize: async () => {} }),
      getSession: (id) => id === "session" ? { workspaceId: "workspace", cwd: root } : undefined,
      getWorkspace: (id) => id === "workspace" ? { id, name: "project", path: root } : undefined,
    });
    try {
      assert.equal((await request(app).get("/api/background-tasks?workspaceId=missing")).status, 404);
      assert.equal((await request(app).get("/api/background-tasks?sessionId=missing")).status, 404);
      assert.equal((await request(app).post("/api/background-tasks").send({ sessionId: "session", workspaceId: "other", command: "x" })).status, 404);
      assert.equal((await request(app).get("/api/background-tasks/bg_../logs")).status, 400);
      assert.equal((await request(app).post("/api/background-tasks").send({ command: "x", cwd: "../outside" })).status, 400);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not run mutating requests when the session permission gate denies them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-bg-routes-permission-"));
    const manager = fakeManager();
    const app = express();
    app.use(express.json());
    registerBackgroundTaskRoutes(app, {
      workspace: root,
      enabled: true,
      getRuntime: () => ({ manager, initialize: async () => {} }),
      getSession: (id) => id === "session" ? { workspaceId: "workspace", cwd: root } : undefined,
      getWorkspace: (id) => id === "workspace" ? { id, name: "project", path: root } : undefined,
      authorize: async () => { throw new Error("Permission denied"); },
    });
    try {
      const response = await request(app)
        .post("/api/background-tasks")
        .send({ sessionId: "session", command: "printf denied" });
      assert.equal(response.status, 403);
      assert.deepEqual(manager.calls, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
