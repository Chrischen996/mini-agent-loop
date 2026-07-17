import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findExactModelReferenceMatch,
  getAllModels,
  getAvailableModels,
  MODEL_REGISTRY,
} from "../src/models.ts";

describe("model selection", () => {
  it("lists only models with a configured credential", () => {
    const models = getAvailableModels({ DEEPSEEK_API_KEY: "test" });
    assert.deepEqual(
      models.map((model) => model.id),
      ["deepseek-chat", "deepseek-reasoner", "deepseek-v4.0-flsh", "deepseek-v4.0.pro"],
    );
    assert.equal(models.find((model) => model.id === "deepseek-v4.0-flsh")?.contextWindow, 131072);
    assert.equal(models.find((model) => model.id === "deepseek-v4.0.pro")?.contextWindow, 131072);
    assert.equal(getAvailableModels({ OPENAI_API_KEY: "test" }).some((model) => model.provider === "deepseek"), false);
  });

  it("covers the built-in OpenAI-compatible provider catalog", () => {
    const env = {
      OPENAI_API_KEY: "test",
      DEEPSEEK_API_KEY: "test",
      GEMINI_API_KEY: "test",
      DASHSCOPE_API_KEY: "test",
      ZHIPU_API_KEY: "test",
      MOONSHOT_API_KEY: "test",
      XAI_API_KEY: "test",
      MISTRAL_API_KEY: "test",
      GROQ_API_KEY: "test",
      OPENROUTER_API_KEY: "test",
      SILICONFLOW_API_KEY: "test",
    };
    assert.deepEqual(
      [...new Set(getAvailableModels(env).map((model) => model.provider))],
      ["deepseek", "openai", "google", "dashscope", "zhipu", "moonshot", "xai", "mistral", "groq", "openrouter", "siliconflow"],
    );
  });

  it("matches qualified and unqualified model references case-insensitively", () => {
    const models = [MODEL_REGISTRY["deepseek-chat"]!];
    assert.equal(findExactModelReferenceMatch("DEEPSEEK/DEEPSEEK-CHAT", models)?.model?.id, "deepseek-chat");
    assert.equal(findExactModelReferenceMatch("DeepSeek-Chat", models)?.model?.id, "deepseek-chat");
  });

  it("reports duplicate unqualified ids as ambiguous", () => {
    const models = [
      { ...MODEL_REGISTRY["gpt-4o"]!, provider: "gateway-a" },
      { ...MODEL_REGISTRY["gpt-4o"]!, provider: "gateway-b", baseUrl: "https://other.example/v1" },
    ];
    const match = findExactModelReferenceMatch("gpt-4o", models);
    assert.equal(match?.ambiguous, true);
    if (match?.ambiguous) assert.equal(match.matches.length, 2);
  });

  it("supports model ids containing slashes", () => {
    const models = getAllModels({ OPENROUTER_API_KEY: "test" });
    const match = findExactModelReferenceMatch("openrouter/anthropic/claude-sonnet-4", models);
    assert.equal(match?.model?.provider, "openrouter");
    assert.equal(match?.model?.id, "anthropic/claude-sonnet-4");
  });

  it("loads custom OpenAI-compatible models from MINI_AGENT_MODELS", () => {
    const env = {
      CUSTOM_LLM_KEY: "test",
      MINI_AGENT_MODELS: JSON.stringify([{
        provider: "local-gateway",
        id: "company-model-v1",
        baseUrl: "https://llm.example/v1",
        apiKeyEnv: "CUSTOM_LLM_KEY",
        input: ["text", "image"],
        contextWindow: 64000,
      }]),
    };
    const models = getAvailableModels(env);
    const custom = models.find((model) => model.provider === "local-gateway");
    assert.equal(custom?.id, "company-model-v1");
    assert.deepEqual(custom?.capabilities.input, ["text", "image"]);
    assert.equal(custom?.contextWindow, 64000);
  });
});
