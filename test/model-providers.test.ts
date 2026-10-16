import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import request from "supertest";
import { completeChat, makeLlmConfig } from "../src/llm/index.ts";
import { createAgentServer } from "../src/server.ts";

const llm = makeLlmConfig({
  apiKey: "default-key",
  baseUrl: "http://localhost/v1",
  model: "faux",
});

describe("custom model providers", () => {
  it("persists providers, hides keys, exposes models, and switches sessions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-model-provider-"));
    const workspace = path.join(root, "workspace");
    const modelConfigPath = path.join(root, "models.json");
    await mkdir(workspace);
    let capturedModel = "";
    let capturedBaseUrl = "";
    let capturedKey = "";
    try {
      const app = createAgentServer({
        llm,
        tools: [],
        workspace,
        dataDir: root,
        modelConfigPath,
        chat: async (config) => {
          capturedModel = config.model;
          capturedBaseUrl = config.baseUrl;
          capturedKey = config.apiKey;
          return { role: "assistant", content: "ok" };
        },
      });

      const saved = await request(app)
        .post("/api/model-providers")
        .send({
          provider: "team-gateway",
          displayName: "Team Gateway",
          baseUrl: "https://llm.example",
          protocol: "openai-completions",
          apiKey: "team-secret",
          models: [{ id: "team-chat", name: "Team Chat", contextWindow: 64_000 }],
        });
      assert.equal(saved.status, 201);
      assert.doesNotMatch(saved.text, /team-secret/);

      const providers = await request(app).get("/api/model-providers");
      assert.equal(providers.status, 200);
      assert.deepEqual((providers.body as { providers: Array<{ provider: string; keyConfigured: boolean }> }).providers, [
          { provider: "team-gateway", displayName: "Team Gateway", baseUrl: "https://llm.example", protocol: "openai-completions", keyConfigured: true, models: [{ id: "team-chat", name: "Team Chat", contextWindow: 64000, maxTokens: 16384, input: ["text"], tools: true, reasoning: false }] },
      ]);
      assert.doesNotMatch(providers.text, /team-secret/);

      const catalog = await request(app).get("/api/models");
      assert.equal(catalog.status, 200);
      assert.ok((catalog.body as { models: Array<{ qualifiedId: string }> }).models.some((model) => model.qualifiedId === "team-gateway/team-chat"));

      const created = await request(app).post("/api/sessions");
      assert.equal(created.status, 201);
      const sessionId = (created.body as { id: string }).id;
      const selected = await request(app)
        .put(`/api/sessions/${sessionId}/model`)
        .send({ model: "team-gateway/team-chat" });
      assert.equal(selected.status, 200);
      assert.equal((selected.body as { qualifiedId: string }).qualifiedId, "team-gateway/team-chat");

      const message = await request(app)
        .post(`/api/sessions/${sessionId}/messages`)
        .field("prompt", "hello");
      assert.equal(message.status, 200);
      assert.equal(capturedModel, "team-chat");
      assert.equal(capturedBaseUrl, "https://llm.example");
      assert.equal(capturedKey, "team-secret");

      const restoredApp = createAgentServer({
        llm,
        tools: [],
        workspace,
        dataDir: root,
        modelConfigPath,
        chat: async (config) => {
          capturedModel = config.model;
          return { role: "assistant", content: "restored" };
        },
      });
      const restored = await request(restoredApp).get(`/api/sessions/${sessionId}`);
      assert.equal(restored.status, 200);
      assert.equal((restored.body as { modelId: string }).modelId, "team-gateway/team-chat");

      const deleted = await request(restoredApp).delete("/api/model-providers/team-gateway");
      assert.equal(deleted.status, 204);
      const afterDelete = await request(restoredApp).get("/api/models");
      assert.equal((afterDelete.body as { models: Array<{ qualifiedId: string }> }).models.some((model) => model.qualifiedId === "team-gateway/team-chat"), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets a custom route override a built-in provider/model entry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-model-override-"));
    const workspace = path.join(root, "workspace");
    const modelConfigPath = path.join(root, "models.json");
    await mkdir(workspace);
    const originalDeepSeekKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "built-in-test-key";
    try {
      const app = createAgentServer({ llm, tools: [], workspace, dataDir: root, modelConfigPath });
      const builtInCatalog = await request(app).get("/api/models");
      const builtInModel = (builtInCatalog.body as { models: Array<{ qualifiedId: string; name: string }> }).models.find((entry) => entry.qualifiedId === "deepseek/deepseek-v4-pro");
      assert.ok(builtInModel);
      assert.notEqual(builtInModel.name, "Custom DeepSeek V4 Pro");
      const saved = await request(app).post("/api/model-providers").send({
        provider: "deepseek",
        baseUrl: "https://custom.deepseek.example/v1",
        protocol: "openai-completions",
        apiKey: "custom-key",
        models: [{ id: "deepseek-v4-pro", name: "Custom DeepSeek V4 Pro" }],
      });
      assert.equal(saved.status, 201);
      const catalog = await request(app).get("/api/models");
      const model = (catalog.body as { models: Array<{ qualifiedId: string; name: string }> }).models.find((entry) => entry.qualifiedId === "deepseek/deepseek-v4-pro");
      assert.equal(model?.qualifiedId, "deepseek/deepseek-v4-pro");
      assert.equal(model?.name, "Custom DeepSeek V4 Pro");
    } finally {
      if (originalDeepSeekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = originalDeepSeekKey;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sends custom Anthropic requests without duplicating the API version", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-anthropic-provider-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestedKey: string | null = null;
    let requestedModel: unknown;
    try {
      globalThis.fetch = (async (input, init) => {
        requestedUrl = input instanceof Request ? input.url : String(input);
        requestedKey = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("x-api-key");
        const body = init?.body
          ? JSON.parse(String(init.body)) as Record<string, unknown>
          : input instanceof Request ? await input.json() as Record<string, unknown> : {};
        requestedModel = body.model;
        const events = [
          { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "native-claude", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        ];
        return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch;
      const app = createAgentServer({ llm, tools: [], workspace, dataDir: root, modelConfigPath: path.join(root, "models.json"), chat: completeChat });
      const saved = await request(app).post("/api/model-providers").send({
        provider: "native-gateway",
        baseUrl: "https://anthropic.example/gateway/v1/",
        protocol: "anthropic-messages",
        apiKey: "native-test-key",
        models: [{ id: "native-claude" }],
      });
      assert.equal(saved.status, 201);
      const created = await request(app).post("/api/sessions");
      const sessionId = (created.body as { id: string }).id;
      const selected = await request(app).put(`/api/sessions/${sessionId}/model`).send({ model: "native-gateway/native-claude" });
      assert.equal(selected.status, 200);
      const message = await request(app).post(`/api/sessions/${sessionId}/messages`).field("prompt", "hello");
      assert.equal(message.status, 200);
      assert.equal(requestedUrl, "https://anthropic.example/gateway/v1/messages");
      assert.equal(requestedKey, "native-test-key");
      assert.equal(requestedModel, "native-claude");
      assert.match(message.text, /"content":"ok"/);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers OpenAI-compatible models and validates required fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-model-discovery-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let discoveryCount = 0;
    try {
      globalThis.fetch = (async (input) => {
        requestedUrl = String(input);
        discoveryCount += 1;
        const body = discoveryCount === 1
          ? { data: [{ id: "one" }, { id: "one" }, { id: "two", name: "Two" }] }
          : { models: { "rich-model": { id: "ignored-id", display_name: "Rich Model", context_window: 64_000, max_output_tokens: 8_192, input_modalities: ["text", "image"] } } };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      const app = createAgentServer({ llm, tools: [], workspace, dataDir: root, modelConfigPath: path.join(root, "models.json") });
      const missingKey = await request(app).post("/api/model-providers/discover").send({ baseUrl: "https://llm.example/v1", protocol: "openai-completions" });
      assert.equal(missingKey.status, 400);
      const discovered = await request(app).post("/api/model-providers/discover").send({ baseUrl: "https://llm.example/v1/", protocol: "openai-completions", apiKey: "discover-key" });
      assert.equal(discovered.status, 200);
      assert.equal(requestedUrl, "https://llm.example/v1/models");
      assert.deepEqual(discovered.body, { models: [{ id: "one", name: "one" }, { id: "two", name: "Two" }] });
      const rich = await request(app).post("/api/model-providers/discover").send({ baseUrl: "https://llm.example/v1", protocol: "openai-completions", apiKey: "discover-key" });
      assert.equal(rich.status, 200);
      assert.deepEqual(rich.body, { models: [{ id: "rich-model", name: "Rich Model", contextWindow: 64000, maxTokens: 8192, input: ["text", "image"] }] });
      await request(app).post("/api/model-providers/discover").send({ baseUrl: "https://gateway.example", protocol: "openai-completions", apiKey: "discover-key" });
      assert.equal(requestedUrl, "https://gateway.example/models");
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });
});

