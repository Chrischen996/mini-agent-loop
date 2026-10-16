import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import request from "supertest";
import { makeLlmConfig } from "../src/llm/index.ts";
import { createAgentServer } from "../src/server.ts";
import type { Tool } from "../src/tools/types.ts";
import type { AgentMessage, AssistantMessage } from "../src/types.ts";

const llm = makeLlmConfig({ apiKey: "must-not-leak", baseUrl: "http://localhost/v1", model: "faux" });
const read: Tool = {
  name: "read", description: "Read a test value", parameters: { type: "object", properties: {} },
  execute: async () => ({ content: "saved tool result" }),
};
const toolReply = (id: string): AssistantMessage => ({
  role: "assistant", content: "", toolCalls: [{ id, name: "read", arguments: {} }],
});
const eventsFrom = (text: string): Array<Record<string, unknown>> =>
  text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

describe("Web turn limit recovery", () => {
  it("finishes a task beyond the default 30 calls without reporting a max-turn error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-max-turns-"));
    let calls = 0;
    let executions = 0;
    try {
      const app = createAgentServer({
        llm, workspace: root, dataDir: root, autoSubagent: { enabled: false },
        tools: [{ ...read, execute: async () => { executions++; return { content: "saved tool result" }; } }],
        chat: async (_config, messages) => {
          calls++;
          if (calls <= 30) return { role: "assistant", content: "", toolCalls: [{ id: `read-${calls}`, name: "read", arguments: { index: calls } }] };
          assert.equal(messages.filter((message) => message.role === "tool").length, 30);
          return { role: "assistant", content: "task completed after 30 tools" };
        },
      });
      const created = await request(app).post("/api/sessions");
      const id = (created.body as { id: string }).id;
      const response = await request(app).post(`/api/sessions/${id}/messages`).field("prompt", "read the values");
      assert.equal(response.status, 200);
      const events = eventsFrom(response.text);
      assert.equal(calls, 31);
      assert.equal(executions, 30);
      assert.equal(events.filter((event) => event.type === "auto_continue").length, 0);
      assert.equal(events.some((event) => event.type === "max_turns" || event.type === "error"), false);
      assert.equal(events.at(-1)?.type, "done");
      assert.equal(events.filter((event) => event.type === "user").length, 1);
      const history = await request(app).get(`/api/sessions/${id}`);
      assert.match(history.text, /task completed after 30 tools/);
      assert.equal(response.text.includes("must-not-leak"), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("saves the final stopped tool block and resumes it after a server restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-max-turns-resume-"));
    let calls = 0;
    try {
      const app = createAgentServer({
        llm, tools: [read], workspace: root, dataDir: root,
        maxTurns: 2, maxAutoContinues: 1,
        chat: async () => toolReply(`read-${++calls}`),
      });
      const created = await request(app).post("/api/sessions");
      const id = (created.body as { id: string }).id;
      const response = await request(app).post(`/api/sessions/${id}/messages`).field("prompt", "original request");
      const events = eventsFrom(response.text);
      assert.equal(calls, 4);
      assert.equal(events.filter((event) => event.type === "max_turns").length, 1);
      assert.equal(events.at(-1)?.type, "max_turns");
      assert.equal(events.at(-1)?.maxTurns, 4);
      assert.equal(events.some((event) => event.type === "error" || event.type === "done"), false);

      const stopped = await request(app).get(`/api/sessions/${id}`);
      const messages = (stopped.body as { messages: AgentMessage[] }).messages;
      assert.equal(messages.filter((message) => message.role === "tool").length, 4);
      assert.equal(messages.at(-1)?.role, "tool");
      assert.equal(messages.filter((message) => message.role === "user" && message.content === "original request").length, 1);

      const restored = createAgentServer({
        llm, tools: [read], workspace: root, dataDir: root,
        chat: async (_config, restoredMessages) => {
          assert.equal(restoredMessages.filter((message) => message.role === "tool").length, 4);
          return { role: "assistant", content: "continued from saved results" };
        },
      });
      const resumed = await request(restored).post(`/api/sessions/${id}/messages`).field("prompt", "continue");
      assert.equal(resumed.status, 200);
      assert.equal(eventsFrom(resumed.text).at(-1)?.type, "done");
      assert.match(resumed.text, /continued from saved results/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the same bounded continuation for plan generation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-max-turns-plan-"));
    let calls = 0;
    try {
      const app = createAgentServer({
        llm, tools: [read], workspace: root, dataDir: root, maxTurns: 1,
        chat: async () => ++calls === 1 ? toolReply("plan-read") : {
          role: "assistant", content: "# Implementation plan\n\n1. Update the requested file.\n2. Verify the result.",
        },
      });
      const created = await request(app).post("/api/sessions");
      const id = (created.body as { id: string }).id;
      const response = await request(app).post(`/api/sessions/${id}/plan/generate`).send({ prompt: "prepare a plan" });
      assert.equal(response.status, 200);
      assert.equal(calls, 2);
      assert.match((response.body as { answer: string }).answer, /Implementation plan/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
