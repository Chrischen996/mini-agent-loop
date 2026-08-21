import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import request from "supertest";
import { makeLlmConfig } from "../src/llm/index.ts";
import { createAgentServer } from "../src/server.ts";

const llm = makeLlmConfig({ apiKey: "test", baseUrl: "http://localhost/v1", model: "faux" });

describe("orchestration server APIs", () => {
  it("runs a background job and persists confirmed project memory", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "orchestration-server-"));
    try {
      const app = createAgentServer({
        llm,
        dataDir,
        permissionMode: "bypass",
        tools: [],
        chat: async () => ({ role: "assistant", content: "background result" }),
      });
      const created = await request(app).post("/api/sessions");
      const sessionId = (created.body as { id: string }).id;
      const memory = await request(app).post("/api/memory").send({
        scope: "project",
        key: "style",
        content: "Use strict TypeScript",
      });
      assert.equal(memory.status, 201);
      const confirmed = await request(app).post(`/api/memory/${memory.body.record.id}/confirm`);
      assert.equal(confirmed.status, 200);

      const started = await request(app).post(`/api/sessions/${sessionId}/jobs`).send({ prompt: "Implement style" });
      assert.equal(started.status, 202);
      const jobId = (started.body as { job: { id: string } }).job.id;
      let status = "queued";
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await request(app).get(`/api/jobs/${jobId}`);
        status = (current.body as { job: { status: string } }).job.status;
        if (status === "completed" || status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(status, "completed");
      const session = await request(app).get(`/api/sessions/${sessionId}`);
      assert.equal(session.body.busy, false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects concurrent background jobs for the same session before persistence yields", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "orchestration-concurrency-"));
    try {
      const app = createAgentServer({
        llm,
        dataDir,
        permissionMode: "bypass",
        tools: [],
        chat: async () => ({ role: "assistant", content: "concurrent result" }),
      });
      const created = await request(app).post("/api/sessions");
      const sessionId = (created.body as { id: string }).id;

      const responses = await Promise.all([
        request(app).post(`/api/sessions/${sessionId}/jobs`).send({ prompt: "first job" }),
        request(app).post(`/api/sessions/${sessionId}/jobs`).send({ prompt: "second job" }),
      ]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);

      const accepted = responses.find((response) => response.status === 202);
      const jobId = (accepted?.body as { job: { id: string } }).job.id;
      let status = "queued";
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const current = await request(app).get(`/api/jobs/${jobId}`);
        status = (current.body as { job: { status: string } }).job.status;
        if (status === "completed" || status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(status, "completed");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("runs the planner-worker-reviewer job kind through real subagent profiles", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "orchestration-workflow-"));
    try {
      const app = createAgentServer({
        llm,
        dataDir,
        permissionMode: "bypass",
        subagentEnabled: true,
        tools: [],
        chat: async (_config, messages) => {
          const user = [...messages].reverse().find((message) => message.role === "user");
          const task = user && user.role === "user" ? String(user.content) : "";
          if (/Create a concise implementation plan/i.test(task)) return { role: "assistant", content: "inspect\nimplement\nvalidate" };
          if (/Review the worker result/i.test(task)) return { role: "assistant", content: "PASS: acceptance criteria met" };
          return { role: "assistant", content: "worker completed" };
        },
      });
      const created = await request(app).post("/api/sessions");
      const sessionId = (created.body as { id: string }).id;
      const started = await request(app).post(`/api/sessions/${sessionId}/jobs`).send({
        prompt: "Implement the feature",
        kind: "planner_worker_reviewer",
      });
      assert.equal(started.status, 202);
      const jobId = (started.body as { job: { id: string } }).job.id;
      let job: { status: string; workOrder?: unknown; reviewReport?: { decision: string } } | undefined;
      // Evidence collection runs a real typecheck. Under the full suite it can
      // exceed five seconds, so bound the wait by a workflow-sized deadline.
      for (let attempt = 0; attempt < 3000; attempt += 1) {
        const current = await request(app).get(`/api/jobs/${jobId}`);
        job = (current.body as { job: typeof job }).job;
        if (job?.status === "completed" || job?.status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(job?.status, "completed");
      assert.ok(job?.workOrder);
      assert.equal(job?.reviewReport?.decision, "pass");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("retries a failed background job through the HTTP lifecycle", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "orchestration-retry-"));
    let calls = 0;
    try {
      const app = createAgentServer({
        llm,
        dataDir,
        permissionMode: "bypass",
        tools: [],
        chat: async () => {
          calls += 1;
          if (calls === 1) throw new Error("first attempt failed");
          return { role: "assistant", content: "retry succeeded" };
        },
      });
      const created = await request(app).post("/api/sessions");
      const sessionId = (created.body as { id: string }).id;
      const started = await request(app).post(`/api/sessions/${sessionId}/jobs`).send({ prompt: "retry this" });
      const jobId = (started.body as { job: { id: string } }).job.id;
      let status = "queued";
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const current = await request(app).get(`/api/jobs/${jobId}`);
        status = (current.body as { job: { status: string } }).job.status;
        if (status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(status, "failed");

      const retried = await request(app).post(`/api/jobs/${jobId}/retry`).send({});
      assert.equal(retried.status, 202);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const current = await request(app).get(`/api/jobs/${jobId}`);
        status = (current.body as { job: { status: string } }).job.status;
        if (status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(status, "completed");
      assert.equal(calls, 2);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
