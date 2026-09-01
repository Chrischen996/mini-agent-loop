import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import request from "supertest";
import { makeLlmConfig } from "../src/llm/index.ts";
import {
  loadPlanDocument,
  markPlanExecutionResult,
  preparePlanForExecution,
} from "../src/plan/index.ts";
import { createAgentServer } from "../src/server.ts";
import type { AgentMessage, AssistantMessage } from "../src/types.ts";

const llm = makeLlmConfig({
  apiKey: "must-not-leak",
  baseUrl: "http://localhost/v1",
  model: "faux",
});

function parseNdjson(text: string): Array<Record<string, unknown>> {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("server plan API", () => {
  it("creates, loads, approves, edits, rejects, archives, and lists history", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "mini-agent-server-plan-"));
    const app = createAgentServer({
      llm,
      tools: [],
      chat: async () => ({ role: "assistant", content: "unused" }),
      dataDir,
    });

    try {
      const created = await request(app).post("/api/sessions");
      assert.equal(created.status, 201);
      const sessionId = (created.body as { id: string }).id;

      const empty = await request(app).get(`/api/sessions/${sessionId}/plan`);
      assert.equal(empty.status, 200);
      assert.equal((empty.body as { plan: null }).plan, null);

      const posted = await request(app)
        .post(`/api/sessions/${sessionId}/plan`)
        .send({
          prompt: "ship feature",
          plan: "1. Read files\n2. Edit src/app.ts\n3. Run tests",
        });
      assert.equal(posted.status, 201);
      const pending = (posted.body as { plan: { id: string; status: string; prompt: string } }).plan;
      assert.equal(pending.status, "pending");
      assert.equal(pending.prompt, "ship feature");

      const loaded = await request(app).get(`/api/sessions/${sessionId}/plan`);
      assert.equal(loaded.status, 200);
      assert.equal((loaded.body as { plan: { status: string } }).plan.status, "pending");

      const sessionDetail = await request(app).get(`/api/sessions/${sessionId}`);
      assert.equal(sessionDetail.status, 200);
      assert.equal((sessionDetail.body as { planStatus: string }).planStatus, "pending");

      const approved = await request(app)
        .post(`/api/sessions/${sessionId}/plan/approve`)
        .send({ by: "tester" });
      assert.equal(approved.status, 200);
      assert.equal((approved.body as { plan: { status: string; approvedBy: string } }).plan.status, "approved");
      assert.equal((approved.body as { plan: { approvedBy: string } }).plan.approvedBy, "tester");

      const edited = await request(app)
        .post(`/api/sessions/${sessionId}/plan/edit`)
        .send({ plan: "1. New step only" });
      assert.equal(edited.status, 200);
      assert.equal((edited.body as { plan: { status: string; rawMarkdown: string } }).plan.status, "pending");
      assert.equal((edited.body as { plan: { rawMarkdown: string } }).plan.rawMarkdown, "1. New step only");

      // Reject path on another session
      const other = await request(app).post("/api/sessions");
      const otherId = (other.body as { id: string }).id;
      await request(app)
        .post(`/api/sessions/${otherId}/plan`)
        .send({ prompt: "other", plan: "1. Something" });
      const rejected = await request(app).post(`/api/sessions/${otherId}/plan/reject`);
      assert.equal(rejected.status, 200);
      assert.equal((rejected.body as { plan: { status: string } }).plan.status, "rejected");

      const archived = await request(app).post(`/api/sessions/${sessionId}/plan/archive`);
      assert.equal(archived.status, 200);
      assert.ok(typeof (archived.body as { archivedPath: string }).archivedPath === "string");
      assert.equal((archived.body as { plan: { id: string } }).plan.id, pending.id);

      const history = await request(app).get(`/api/sessions/${sessionId}/plan/history`);
      assert.equal(history.status, 200);
      const plans = (history.body as { plans: Array<{ id: string }> }).plans;
      assert.ok(plans.some((plan) => plan.id === pending.id));
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps the in-memory plan registry owned by the forked session", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "mini-agent-server-plan-fork-"));
    const app = createAgentServer({
      llm,
      tools: [],
      chat: async () => ({ role: "assistant", content: "unused" }),
      dataDir,
    });

    try {
      const created = await request(app).post("/api/sessions");
      const parentId = (created.body as { id: string }).id;
      const posted = await request(app)
        .post(`/api/sessions/${parentId}/plans`)
        .send({
          output: JSON.stringify({
            summary: "Forkable plan",
            steps: [{ id: "step-1", order: 1, description: "Read", tool: "read", arguments: {}, risk: "safe", rationale: "inspect" }],
          }),
        });
      assert.equal(posted.status, 201);
      const parentPlan = (posted.body as { id: string; sessionId: string });

      const forked = await request(app).post(`/api/sessions/${parentId}/fork`);
      assert.equal(forked.status, 201);
      const childId = (forked.body as { id: string }).id;
      const childPlans = await request(app).get(`/api/sessions/${childId}/plans`);
      assert.equal(childPlans.status, 200);
      const childPlan = (childPlans.body as Array<{ id: string; sessionId: string }>)[0];
      assert.ok(childPlan);
      assert.notEqual(childPlan.id, parentPlan.id);
      assert.equal(childPlan.sessionId, childId);

      const parentPlans = await request(app).get(`/api/sessions/${parentId}/plans`);
      assert.deepEqual((parentPlans.body as Array<{ id: string }>).map((plan) => plan.id), [parentPlan.id]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("execute requires approval unless yes is set, and streams completion", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "mini-agent-server-plan-exec-"));
    const chat = async (
      _config: typeof llm,
      messages: AgentMessage[],
    ): Promise<AssistantMessage> => {
      const users = messages.filter((message) => message.role === "user").length;
      return { role: "assistant", content: `executed turn ${users}` };
    };
    const app = createAgentServer({
      llm,
      tools: [],
      chat,
      dataDir,
    });

    try {
      const created = await request(app).post("/api/sessions");
      const sessionId = (created.body as { id: string }).id;

      await request(app)
        .post(`/api/sessions/${sessionId}/plan`)
        .send({ prompt: "do work", plan: "1. Implement\n2. Verify" });

      const blocked = await request(app).post(`/api/sessions/${sessionId}/plan/execute`).send({});
      assert.equal(blocked.status, 400);
      assert.match((blocked.body as { error: string }).error, /not approved/i);

      const withYes = await request(app)
        .post(`/api/sessions/${sessionId}/plan/execute`)
        .send({ yes: true });
      assert.equal(withYes.status, 200);
      const events = parseNdjson(withYes.text);
      assert.ok(events.some((event) => event.type === "plan_execution_started"));
      assert.ok(events.some((event) => event.type === "plan_execution_finished"));
      const finished = events.find((event) => event.type === "plan_execution_finished");
      assert.equal(finished?.status, "completed");

      const after = await request(app).get(`/api/sessions/${sessionId}/plan`);
      assert.equal((after.body as { plan: { status: string } }).plan.status, "completed");

      const history = await request(app).get(`/api/sessions/${sessionId}/plan/history`);
      assert.ok((history.body as { plans: unknown[] }).plans.length >= 1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("retry works after a failed execution", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "mini-agent-server-plan-retry-"));
    let calls = 0;
    const chat = async (): Promise<AssistantMessage> => {
      calls += 1;
      if (calls === 1) {
        throw new Error("boom during execute");
      }
      return { role: "assistant", content: "retry ok" };
    };
    const app = createAgentServer({
      llm,
      tools: [],
      chat,
      dataDir,
    });

    try {
      const created = await request(app).post("/api/sessions");
      const sessionId = (created.body as { id: string }).id;

      await request(app)
        .post(`/api/sessions/${sessionId}/plan`)
        .send({
          prompt: "retry me",
          plan: "1. Attempt",
          autoApprove: true,
        });

      const first = await request(app).post(`/api/sessions/${sessionId}/plan/execute`).send({});
      assert.equal(first.status, 200);
      const firstEvents = parseNdjson(first.text);
      assert.ok(firstEvents.some((event) => event.type === "error"));
      const firstFinished = firstEvents.find((event) => event.type === "plan_execution_finished");
      assert.equal(firstFinished?.status, "failed");

      const failed = await request(app).get(`/api/sessions/${sessionId}/plan`);
      assert.equal((failed.body as { plan: { status: string } }).plan.status, "failed");

      const retry = await request(app).post(`/api/sessions/${sessionId}/plan/retry`).send({});
      assert.equal(retry.status, 200);
      const retryEvents = parseNdjson(retry.text);
      const finished = retryEvents.find((event) => event.type === "plan_execution_finished");
      assert.equal(finished?.status, "completed");
      assert.ok(retryEvents.some((event) => event.type === "plan_execution_started" && event.retry === true));
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("generate runs a plan-only turn and saves the plan", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "mini-agent-server-plan-gen-"));
    const chat = async (
      _config: typeof llm,
      messages: AgentMessage[],
    ): Promise<AssistantMessage> => {
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const text =
        lastUser && lastUser.role === "user"
          ? typeof lastUser.content === "string"
            ? lastUser.content
            : "plan"
          : "plan";
      assert.match(text, /PLAN-ONLY MODE/);
      return {
        role: "assistant",
        content: "1. Inspect codebase\n2. Write the change\n3. Validate",
      };
    };
    const app = createAgentServer({
      llm,
      tools: [],
      chat,
      dataDir,
      permissionMode: "bypass",
    });

    try {
      const created = await request(app).post("/api/sessions");
      const sessionId = (created.body as { id: string }).id;

      // Session starts in bypass; generate should temporarily force plan mode.
      const modeBefore = await request(app).get(`/api/sessions/${sessionId}/permission-mode`);
      assert.equal((modeBefore.body as { mode: string }).mode, "bypass");

      const generated = await request(app)
        .post(`/api/sessions/${sessionId}/plan/generate`)
        .send({ prompt: "add logging" });
      assert.equal(generated.status, 200);
      const body = generated.body as {
        plan: { status: string; prompt: string; rawMarkdown: string };
        answer: string;
      };
      assert.equal(body.plan.status, "pending");
      assert.equal(body.plan.prompt, "add logging");
      assert.match(body.answer, /Inspect codebase/);
      assert.match(body.plan.rawMarkdown, /Inspect codebase/);

      const modeAfter = await request(app).get(`/api/sessions/${sessionId}/permission-mode`);
      assert.equal((modeAfter.body as { mode: string }).mode, "bypass");

      const history = await request(app).get(`/api/sessions/${sessionId}`);
      const roles = (history.body as { messages: Array<{ role: string }> }).messages.map((m) => m.role);
      assert.ok(roles.includes("user"));
      assert.ok(roles.includes("assistant"));
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("returns 404 for missing sessions and no-plan mutations", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "mini-agent-server-plan-404-"));
    const app = createAgentServer({
      llm,
      tools: [],
      chat: async () => ({ role: "assistant", content: "ok" }),
      dataDir,
    });

    try {
      const missing = await request(app).get("/api/sessions/does-not-exist/plan");
      assert.equal(missing.status, 404);

      const created = await request(app).post("/api/sessions");
      const sessionId = (created.body as { id: string }).id;
      const approveEmpty = await request(app).post(`/api/sessions/${sessionId}/plan/approve`).send({});
      assert.equal(approveEmpty.status, 404);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps plans isolated per session under dataDir", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "mini-agent-server-plan-iso-"));
    const app = createAgentServer({
      llm,
      tools: [],
      chat: async () => ({ role: "assistant", content: "ok" }),
      dataDir,
    });

    try {
      const a = await request(app).post("/api/sessions");
      const b = await request(app).post("/api/sessions");
      const idA = (a.body as { id: string }).id;
      const idB = (b.body as { id: string }).id;

      await request(app)
        .post(`/api/sessions/${idA}/plan`)
        .send({ prompt: "A", plan: "1. A only" });
      await request(app)
        .post(`/api/sessions/${idB}/plan`)
        .send({ prompt: "B", plan: "1. B only" });

      const planA = await request(app).get(`/api/sessions/${idA}/plan`);
      const planB = await request(app).get(`/api/sessions/${idB}/plan`);
      assert.equal((planA.body as { plan: { prompt: string } }).plan.prompt, "A");
      assert.equal((planB.body as { plan: { prompt: string } }).plan.prompt, "B");

      // Direct filesystem isolation check via plan root helper path.
      const rootA = path.join(dataDir, "session-plans", idA);
      const rootB = path.join(dataDir, "session-plans", idB);
      const loadedA = await loadPlanDocument(rootA);
      const loadedB = await loadPlanDocument(rootB);
      assert.equal(loadedA?.prompt, "A");
      assert.equal(loadedB?.prompt, "B");

      // Kernel helpers still work against the same roots.
      await preparePlanForExecution(rootA, { yes: true });
      await markPlanExecutionResult(rootA, { ok: false, error: "manual fail" });
      const after = await loadPlanDocument(rootA);
      assert.equal(after?.status, "failed");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
