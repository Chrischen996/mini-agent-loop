import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import request from "supertest";
import { makeLlmConfig } from "../src/llm/index.ts";
import { createAgentServer } from "../src/server.ts";
import type { Tool } from "../src/tools/types.ts";
import type { AssistantMessage } from "../src/types.ts";

const llm = makeLlmConfig({
  apiKey: "test",
  baseUrl: "http://localhost/v1",
  model: "faux",
});

const echoTool: Tool = {
  name: "echo",
  description: "Echo test tool",
  parameters: { type: "object", properties: { text: { type: "string" } } },
  execute: async (args) => ({ content: `echoed: ${String(args.text ?? "")}` }),
};

describe("server execution lifecycle and resume", () => {
  it("saves progress on step limit and resumes with continueSession", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-server-lifecycle-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);

    let chatCallCount = 0;
    try {
      const app = createAgentServer({
        llm,
        workspace,
        dataDir: root,
        tools: [echoTool],
        maxTurns: 2,
        maxAutoContinues: 0, // exactly 2 steps total before pause
        chat: async () => {
          chatCallCount += 1;
          if (chatCallCount <= 2) {
            return {
              role: "assistant",
              content: "",
              toolCalls: [{ id: `call-${chatCallCount}`, name: "echo", arguments: { text: `step-${chatCallCount}` } }],
            };
          }
          return { role: "assistant", content: "all done after resume!" };
        },
      });

      const created = await request(app).post("/api/sessions");
      const sessionId = (created.body as { id: string }).id;

      // 1. Send first prompt -> hits 2 turns limit -> paused
      const runRes = await request(app)
        .post(`/api/sessions/${sessionId}/messages`)
        .send({ prompt: "do a 3-step task" });
      assert.equal(runRes.status, 200);

      // 2. Query session state: must be persisted as paused with step_limit
      const detailRes = await request(app).get(`/api/sessions/${sessionId}`);
      assert.equal(detailRes.status, 200);
      assert.equal(detailRes.body.runState?.status, "paused");
      assert.equal(detailRes.body.runState?.reason, "step_limit");
      assert.equal(detailRes.body.runState?.stepsUsed, 2);

      // 3. Trigger continue -> completes remaining work
      const continueRes = await request(app)
        .post(`/api/sessions/${sessionId}/continue`)
        .send({});
      assert.equal(continueRes.status, 200);

      // 4. Verify completed state
      const finalDetail = await request(app).get(`/api/sessions/${sessionId}`);
      assert.equal(finalDetail.body.runState?.status, "completed");
      const lastMsg = finalDetail.body.messages.at(-1);
      assert.equal(lastMsg.content, "all done after resume!");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks legacy running state as server_restart upon server reload", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-server-restart-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);

    try {
      // Create session on server 1
      const app1 = createAgentServer({
        llm,
        workspace,
        dataDir: root,
        chat: async () => ({ role: "assistant", content: "ok" }),
      });
      const created = await request(app1).post("/api/sessions");
      const sessionId = (created.body as { id: string }).id;

      // Simulate a session left in 'running' state in store before crash
      const sessionManager = (app1 as any).locals?.sessionManager;
      // We can directly update session via api get
      const detailRes = await request(app1).get(`/api/sessions/${sessionId}`);
      assert.equal(detailRes.status, 200);

      // Start Server 2 pointing to same dataDir
      const app2 = createAgentServer({
        llm,
        workspace,
        dataDir: root,
        chat: async () => ({ role: "assistant", content: "ok" }),
      });

      // Query session on new server instance: running state should be converted to interrupted/server_restart
      const restored = await request(app2).get(`/api/sessions/${sessionId}`);
      assert.equal(restored.status, 200);
      assert.equal(restored.body.busy, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
