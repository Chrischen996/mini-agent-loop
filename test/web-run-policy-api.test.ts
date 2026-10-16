import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import request from "supertest";
import { makeLlmConfig } from "../src/llm/index.ts";
import { createAgentServer, type AgentServerOptions } from "../src/server.ts";
import type { Tool } from "../src/tools/types.ts";
import type { WebRunState } from "../src/session-store.ts";

const llm = makeLlmConfig({ apiKey: "test", baseUrl: "http://localhost/v1", model: "faux" });
const write: Tool = {
  name: "write", description: "Simulated write", parameters: { type: "object", properties: {} },
  execute: async () => ({ content: "written" }),
};
const frames = (text: string): Record<string, any>[] => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "mini-agent-policy-api-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const base: AgentServerOptions = {
    llm, workspace, dataDir: path.join(root, "data"), skillHome: root,
    tools: [write], permissionMode: "bypass", backgroundTasks: false,
    autoSubagent: { enabled: false }, autoValidate: false, autoCheckpoint: false,
  };
  return { root, base };
}

async function sessionLog(dataDir: string, id: string): Promise<string> {
  const files = await readdir(dataDir, { recursive: true });
  const file = files.find((name) => name.endsWith(path.join(id, "events.jsonl")));
  assert.ok(file, "session JSONL was saved");
  return path.join(dataDir, file);
}

describe("Web policy API and restart persistence", () => {
  it("streams one complete pause, restores usage, and allocates an explicit new budget", async () => {
    const { root, base } = await fixture();
    let calls = 0;
    const chat: AgentServerOptions["chat"] = async () => ({
      role: "assistant", content: "", usage: { totalTokens: 12 },
      toolCalls: [{ id: `write-${++calls}`, name: "write", arguments: { value: calls } }],
    });
    try {
      const app = createAgentServer({ ...base, runPolicy: { toolCallBudget: 1 }, chat });
      const { body: { id } } = await request(app).post("/api/sessions");
      const initial = await request(app).post(`/api/sessions/${id}/messages`).send({ prompt: "write" }).expect(200);
      const events = frames(initial.text);
      const stops = events.filter((event) => event.type === "run_stopped");
      assert.equal(stops.length, 1);
      assert.equal(stops[0].stopReason, "budget_exhausted");
      assert.equal(stops[0].message, stops[0].details);
      assert.match(stops[0].details, /budget exhausted/i);
      assert.equal(stops[0].budgetUsage.tokensUsed, 12);
      assert.equal(stops[0].budgetUsage.toolCallsUsed, 1);
      assert.equal(stops[0].budgetUsage.writeCallsUsed, 1);
      assert.equal(events.some((event) => ["error", "done", "max_turns"].includes(event.type)), false);

      const logPath = await sessionLog(base.dataDir!, id);
      const snapshots = frames(await readFile(logPath, "utf8")).filter((event) => event.runState);
      assert.equal(snapshots.filter((event) => event.runState.status === "paused").length, 1);
      assert.equal(snapshots.some((event) => event.runState.status === "failed"), false);

      const restored = createAgentServer({ ...base, runPolicy: { toolCallBudget: 1 }, chat });
      const detail = await request(restored).get(`/api/sessions/${id}`).expect(200);
      assert.deepEqual(detail.body.runState.budgetUsage, stops[0].budgetUsage);
      assert.match(detail.body.runState.lastFingerprint, /^[a-f0-9]{64}$/);

      const remaining = await request(restored).post(`/api/sessions/${id}/continue`).send({ budgetMode: "remaining" }).expect(200);
      assert.equal(frames(remaining.text).filter((event) => event.type === "run_stopped").length, 1);
      assert.equal(calls, 1, "exhausted remaining budget must not execute another call");
      const next = await request(restored).post(`/api/sessions/${id}/continue`)
        .send({ tokenBudget: 24, toolCallBudget: 10, writeCallBudget: 10, deadlineMs: 300000 }).expect(200);
      const nextStop = frames(next.text).find((event) => event.type === "run_stopped")!;
      assert.equal(calls, 3);
      assert.equal(nextStop.budgetUsage.tokensUsed, 24);
      assert.equal(nextStop.cumulativeBudgetUsage.tokensUsed, 36);
      assert.equal(nextStop.budgetPolicy.deadlineMs, 300000);
      const final = await request(restored).get(`/api/sessions/${id}`).expect(200);
      assert.equal(final.body.messages.filter((message: { role: string }) => message.role === "user").length, 1);
      assert.equal(final.body.runState.budgetMode, "new");
      assert.equal(final.body.runState.cumulativeBudgetUsage.writeCallsUsed, 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores a crashed run and resumes its remaining budget without charging downtime", async () => {
    const { root, base } = await fixture();
    try {
      const app = createAgentServer({ ...base, chat: async () => ({ role: "assistant", content: "initial" }) });
      const { body: { id } } = await request(app).post("/api/sessions");
      await request(app).post(`/api/sessions/${id}/messages`).send({ prompt: "task" }).expect(200);
      const logPath = await sessionLog(base.dataDir!, id);
      const events = frames(await readFile(logPath, "utf8"));
      const latest = [...events].reverse().find((event) => event.runState)!;
      const state: WebRunState = {
        ...latest.runState, status: "running", savedAt: Date.now() - 3600000,
        budgetPolicy: { tokenBudget: 50, toolCallBudget: 5, deadlineMs: 300000, emergencyIterationCap: 50 },
        budgetUsage: { tokensUsed: 20, toolCallsUsed: 2, writeCallsUsed: 1, elapsedMs: 5000 },
        cumulativeBudgetUsage: { tokensUsed: 120, toolCallsUsed: 12, writeCallsUsed: 3, elapsedMs: 20000 },
      };
      latest.runState = state;
      await writeFile(logPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
      const restored = createAgentServer({ ...base, chat: async () => ({ role: "assistant", content: "finished", usage: { totalTokens: 10 } }) });
      const before = await request(restored).get(`/api/sessions/${id}`).expect(200);
      assert.equal(before.body.runState.status, "interrupted");
      assert.equal(before.body.runState.reason, "server_restart");
      assert.deepEqual(before.body.runState.budgetUsage, state.budgetUsage);
      const result = await request(restored).post(`/api/sessions/${id}/continue`).send({ budgetMode: "remaining" }).expect(200);
      assert.equal(frames(result.text).at(-1)?.type, "done");
      const { body: detail } = await request(restored).get(`/api/sessions/${id}`).expect(200);
      assert.equal(detail.runState.status, "completed");
      assert.equal(detail.runState.budgetUsage.tokensUsed, 30);
      assert.equal(detail.runState.cumulativeBudgetUsage.tokensUsed, 130);
      assert.ok(detail.runState.budgetUsage.elapsedMs >= 5000 && detail.runState.budgetUsage.elapsedMs < 10000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid Continue requests before leasing the session or starting a stream", async () => {
    const { root, base } = await fixture();
    let calls = 0;
    try {
      const app = createAgentServer({ ...base, chat: async () => { calls++; return { role: "assistant", content: "ok" }; } });
      const { body: { id } } = await request(app).post("/api/sessions");
      for (const body of [{ tokenBudget: -1 }, { deadlineMs: 1.5 }, { tokenBudget: "50000" }, { budgetMode: "remaining" }, { unknown: 1 }]) {
        const result = await request(app).post(`/api/sessions/${id}/continue`).send(body).expect(400);
        assert.match(result.headers["content-type"], /application\/json/);
        assert.ok(result.body.error);
      }
      assert.equal(calls, 0);
      const { body: detail } = await request(app).get(`/api/sessions/${id}`).expect(200);
      assert.equal(detail.busy, false);
      await request(app).post(`/api/sessions/${id}/continue`).send({}).expect(200);
      assert.equal(calls, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
