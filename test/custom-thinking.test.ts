import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import request from "supertest";
import { completeChat, streamChat, makeLlmConfig, switchLlmModel } from "../src/llm/index.ts";
import { customProviderModels } from "../src/models.ts";
import { validateCustomProvider } from "../src/profile-store.ts";
import { getSelectableThinkingLevels, cycleThinkingLevel } from "../src/think-intensity.ts";
import { createAgentServer } from "../src/server.ts";

const base = makeLlmConfig({ apiKey: "test", baseUrl: "https://test.invalid/v1", model: "faux" });
const provider = {
  baseUrl: "https://test.invalid/v1", protocol: "openai-completions", apiKey: "secret",
  compat: { thinkingFormat: "deepseek", supportsReasoningEffort: true },
  models: [{ id: "reasoner", reasoningEfforts: { off: null, high: "high", max: "ultra" }, defaultThinkingLevel: "high" }],
};
function model() { return customProviderModels({ team: validateCustomProvider("team", provider) })[0]!; }

describe("custom thinking configuration", () => {
  it("limits selectors to declared levels and keeps Off out of effort cycling", () => {
    const config = switchLlmModel(base, model(), { apiKey: "secret" });
    assert.deepEqual(getSelectableThinkingLevels(config), ["off", "high", "max"]);
    assert.equal(config.thinkingLevel, "high");
    assert.equal(cycleThinkingLevel(config, "increase"), "max");
    assert.ok(!getSelectableThinkingLevels({ ...config, provider: "xai" }).includes("off"));
  });

  it("validates mappings, protocol compatibility, and defaults", () => {
    for (const reasoningEfforts of [{}, { high: null }, { mystery: "high" }, { high: "" }, { off: null }]) {
      assert.throws(() => validateCustomProvider("team", { ...provider, models: [{ id: "x", reasoningEfforts }] }));
    }
    assert.throws(() => validateCustomProvider("team", { ...provider, models: [{ ...provider.models[0], defaultThinkingLevel: "low" }] }));
    assert.throws(() => validateCustomProvider("team", { ...provider, protocol: "openai-responses" }));
    assert.throws(() => validateCustomProvider("team", { ...provider, compat: { thinkingFormat: "unknown" } }));
    assert.equal(validateCustomProvider("team", { ...provider, models: [{ id: "x", reasoning: true }] }).models[0]?.reasoning, true);
    assert.equal(validateCustomProvider("team", { ...provider, models: [{ id: "x", reasoning: true, reasoningEfforts: false }] }).models[0]?.reasoning, false);
  });

  it("writes mapped effort and explicit Off identically in complete and streaming requests, including tool replay", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return body.stream
        ? new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
        : Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    }) as typeof fetch;
    try {
      const selected = switchLlmModel(base, model(), { apiKey: "secret" });
      const messages = [
        { role: "user" as const, content: "inspect" },
        { role: "assistant" as const, content: "", toolCalls: [{ id: "call_1", name: "read", arguments: { path: "a" } }] },
        { role: "tool" as const, content: "file content", name: "read", toolCallId: "call_1" },
      ];
      for (const thinkingLevel of ["max", "off"] as const) {
        const config = { ...selected, thinkingLevel };
        await completeChat(config, messages);
        for await (const _event of streamChat(config, messages)) { /* consume request */ }
      }
      for (const body of bodies.slice(0, 2)) {
        assert.deepEqual(body.thinking, { type: "enabled" });
        assert.equal(body.reasoning_effort, "ultra");
        assert.equal((body.messages as unknown[]).length, 3);
      }
      for (const body of bodies.slice(2)) {
        assert.deepEqual(body.thinking, { type: "disabled" });
        assert.equal(body.reasoning_effort, undefined);
      }
    } finally { globalThis.fetch = originalFetch; }
  });

  it("persists choices, restores them, and adopts updated capabilities on the next operation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "custom-thinking-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const options = { llm: base, tools: [], workspace, dataDir: root, modelConfigPath: path.join(root, "models.json"), chat: async () => ({ role: "assistant" as const, content: "ok" }) };
    try {
      const app = createAgentServer(options);
      assert.equal((await request(app).post("/api/model-providers").send({ provider: "team", ...provider })).status, 201);
      const catalog = await request(app).get("/api/models");
      assert.deepEqual(catalog.body.models.find((entry: { qualifiedId: string }) => entry.qualifiedId === "team/reasoner").thinkingLevels, ["off", "high", "max"]);
      const created = await request(app).post("/api/sessions");
      const id = created.body.id as string;
      assert.equal((await request(app).put(`/api/sessions/${id}/model`).send({ model: "team/reasoner" })).body.thinkingLevel, "high");
      assert.equal((await request(app).put(`/api/sessions/${id}/thinking-level`).send({ thinkingLevel: "low" })).status, 400);
      assert.equal((await request(app).put(`/api/sessions/${id}/thinking-level`).send({ thinkingLevel: "off" })).status, 200);
      assert.equal((await request(app).put(`/api/sessions/${id}/thinking-level`).send({ thinkingLevel: "max" })).status, 200);
      const restored = createAgentServer(options);
      assert.equal((await request(restored).get(`/api/sessions/${id}`)).body.thinkingLevel, "max");
      assert.equal((await request(restored).put("/api/model-providers/team").send({ models: [{ id: "reasoner", reasoningEfforts: { high: "high" }, defaultThinkingLevel: "high" }] })).status, 200);
      assert.equal((await request(restored).get(`/api/sessions/${id}`)).body.thinkingLevel, "high");
      assert.equal((await request(restored).put(`/api/sessions/${id}/thinking-level`).send({ thinkingLevel: "off" })).status, 400);
      const restarted = createAgentServer(options);
      assert.equal((await request(restarted).get(`/api/sessions/${id}`)).body.thinkingLevel, "high");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
