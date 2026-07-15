import assert from "node:assert/strict";
import { describe, it } from "node:test";
import request from "supertest";
import { makeLlmConfig } from "../src/llm.ts";
import { createAgentServer } from "../src/server.ts";
import type { AgentMessage, AssistantMessage } from "../src/types.ts";

const llm = makeLlmConfig({
  apiKey: "must-not-leak",
  baseUrl: "http://localhost/v1",
  model: "faux",
});

describe("agent server", () => {
  it("keeps a multi-turn session and streams safe NDJSON events", async () => {
    const chat = async (
      _config: typeof llm,
      messages: AgentMessage[],
    ): Promise<AssistantMessage> => {
      const users = messages.filter((message) => message.role === "user").length;
      return { role: "assistant", content: `server turn ${users}` };
    };
    const app = createAgentServer({
      llm,
      tools: [],
      chat,
      serveWeb: false,
    });

    const config = await request(app).get("/api/config");
    assert.equal(config.status, 200);
    assert.doesNotMatch(config.text, /must-not-leak/);

    const created = await request(app).post("/api/sessions");
    assert.equal(created.status, 201);
    const sessionId = (created.body as { id: string }).id;

    const first = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .field("prompt", "first");
    assert.equal(first.status, 200);
    const firstEvents = first.text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; content?: string });
    assert.deepEqual(firstEvents.map((event) => event.type), [
      "user",
      "assistant",
      "done",
    ]);
    assert.equal(firstEvents[1]?.content, "server turn 1");

    const second = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .field("prompt", "second");
    assert.equal(second.status, 200);
    assert.match(second.text, /server turn 2/);

    const history = await request(app).get(`/api/sessions/${sessionId}`);
    const data = history.body as { messages: Array<{ role: string }> };
    assert.deepEqual(
      data.messages.map((message) => message.role),
      ["user", "assistant", "user", "assistant"],
    );
    assert.doesNotMatch(history.text, /must-not-leak/);
  });

  it("rejects an empty multipart message", async () => {
    const app = createAgentServer({
      llm,
      tools: [],
      chat: async () => ({ role: "assistant", content: "unused" }),
      serveWeb: false,
    });
    const created = await request(app).post("/api/sessions");
    const sessionId = (created.body as { id: string }).id;
    const response = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .field("prompt", "   ");
    assert.equal(response.status, 400);
    assert.match(response.text, /prompt or at least one image/);
  });
});
