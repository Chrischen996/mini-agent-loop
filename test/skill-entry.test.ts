import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import request from "supertest";
import { makeLlmConfig } from "../src/llm/index.ts";
import { createAgentServer } from "../src/server.ts";
import { InMemorySkillRegistry } from "../src/skills/index.ts";

const llm = makeLlmConfig({
  apiKey: "must-not-leak",
  baseUrl: "http://localhost/v1",
  model: "faux",
});

describe("skill entry wiring", () => {
  it("discovers workspace skills and lets a session activate them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-skill-entry-"));
    const dataDir = await mkdtemp(path.join(tmpdir(), "mini-agent-skill-data-"));
    const skillHome = await mkdtemp(path.join(tmpdir(), "mini-agent-skill-home-"));
    const registry = new InMemorySkillRegistry();
    let capturedSystem = "";
    try {
      await mkdir(path.join(root, "skills", "research"), { recursive: true });
      await writeFile(
        path.join(root, "skills", "research", "SKILL.md"),
        "---\nname: repo-research\ndescription: Inspect repositories\n---\nRead the relevant source before answering.",
      );
      const app = createAgentServer({
        llm,
        tools: [],
        workspace: root,
        dataDir,
        skillHome,
        skillRegistry: registry,
        chat: async (_config, messages) => {
          capturedSystem = String(messages.find((message) => message.role === "system")?.content ?? "");
          return { role: "assistant", content: "ok" };
        },
      });

      const config = await request(app).get("/api/config");
      assert.equal(config.status, 200);
      const available = (config.body as { skills: { available: Array<{ name: string }> } }).skills.available;
      assert.deepEqual(available.map((skill) => skill.name), ["repo-research"]);

      const created = await request(app).post("/api/sessions");
      assert.equal(created.status, 201);
      const sessionId = (created.body as { id: string }).id;

      const listed = await request(app).get(`/api/sessions/${sessionId}/skills`);
      assert.equal(listed.status, 200);
      assert.deepEqual((listed.body as { active: string[] }).active, []);

      const missing = await request(app)
        .put(`/api/sessions/${sessionId}/skills`)
        .send({ skillNames: ["missing"] });
      assert.equal(missing.status, 200);
      assert.deepEqual((missing.body as { active: string[]; missing: string[] }).active, []);
      assert.deepEqual((missing.body as { missing: string[] }).missing, ["missing"]);

      const enabled = await request(app)
        .put(`/api/sessions/${sessionId}/skills`)
        .send({ skillNames: ["repo-research"] });
      assert.equal(enabled.status, 200);
      assert.deepEqual((enabled.body as { active: string[] }).active, ["repo-research"]);

      const session = await request(app).get(`/api/sessions/${sessionId}`);
      assert.deepEqual((session.body as { skillNames: string[] }).skillNames, ["repo-research"]);

      const reply = await request(app)
        .post(`/api/sessions/${sessionId}/messages`)
        .field("prompt", "hello");
      assert.equal(reply.status, 200);
      assert.match(capturedSystem, /relevant source before answering/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
