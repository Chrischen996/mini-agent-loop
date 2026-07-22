import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findExactModelReferenceMatch,
  getAllModels,
  getAvailableModels,
  MODEL_REGISTRY,
  resolveModel,
  searchModels,
} from "../src/models.ts";

describe("model selection", () => {
  it("lists only models with a configured credential", () => {
    const models = getAvailableModels({ DEEPSEEK_API_KEY: "test" });
    assert.deepEqual(
      models.map((model) => model.id),
      ["deepseek-v4-flash", "deepseek-v4-pro"],
    );
    assert.equal(models.find((model) => model.id === "deepseek-v4-flash")?.contextWindow, 1000000);
    assert.equal(models.find((model) => model.id === "deepseek-v4-pro")?.contextWindow, 1000000);
    assert.equal(getAvailableModels({ OPENAI_API_KEY: "test" }).some((model) => model.provider === "deepseek"), false);
  });

  it("assigns and normalizes output limits for custom models", () => {
    const env = {
      CUSTOM_LLM_KEY: "test",
      MINI_AGENT_MODELS: JSON.stringify([{
        provider: "small-gateway",
        id: "small-model",
        baseUrl: "https://small.example/v1",
        apiKeyEnv: "CUSTOM_LLM_KEY",
        contextWindow: 100,
        maxTokens: 1000,
      }]),
    };
    const model = getAvailableModels(env).find((item) => item.id === "small-model");
    assert.equal(model?.maxTokens, 99);
  });

  it("covers the generated multi-provider catalog", () => {
    const env = {
      AGNES_API_KEY: "test",
      OPENAI_API_KEY: "test",
      DEEPSEEK_API_KEY: "test",
      GEMINI_API_KEY: "test",
      MOONSHOT_API_KEY: "test",
      XAI_API_KEY: "test",
      MISTRAL_API_KEY: "test",
      GROQ_API_KEY: "test",
      OPENROUTER_API_KEY: "test",
    };
    assert.deepEqual(
      [...new Set(getAvailableModels(env).map((model) => model.provider))],
      ["agnes-ai", "deepseek", "google", "groq", "mistral", "moonshotai", "moonshotai-cn", "openai", "openai-codex", "openrouter", "xai"],
    );
    assert.equal(getAllModels().length, 1075);
    assert.ok(getAllModels().every((model) => model.contextWindow > 0 && model.maxTokens > 0));
  });

  it("registers Agnes AI with its documented OpenAI-compatible capabilities", () => {
    const models = getAvailableModels({ AGNES_API_KEY: "test" })
      .filter((model) => model.provider === "agnes-ai");
    assert.deepEqual(models.map((model) => model.id), ["agnes-2.0-flash", "agnes-2.5-flash"]);
    assert.ok(models.every((model) => model.baseUrl === "https://apihub.agnes-ai.com/v1"));
    assert.ok(models.every((model) => model.capabilities.tools && model.capabilities.input.includes("image")));
    assert.ok(models.every((model) => model.contextWindow === 524288 && model.maxTokens === 65536));
  });

  it("matches qualified and unqualified model references case-insensitively", () => {
    const models = [MODEL_REGISTRY["deepseek-v4-flash"]!];
    assert.equal(findExactModelReferenceMatch("DEEPSEEK/DEEPSEEK-V4-FLASH", models)?.model?.id, "deepseek-v4-flash");
    assert.equal(findExactModelReferenceMatch("DeepSeek-V4-Flash", models)?.model?.id, "deepseek-v4-flash");
  });

  it("maps legacy DeepSeek aliases to the generated catalog", () => {
    assert.equal(resolveModel("deepseek/deepseek-chat").id, "deepseek-v4-flash");
    assert.equal(resolveModel("deepseek-reasoner").id, "deepseek-v4-pro");
  });

  it("keeps Anthropic native transport when using a custom gateway", () => {
    const model = getAllModels().find((item) => item.provider === "anthropic");
    assert.ok(model?.piModel);
    const resolved = resolveModel(`anthropic/${model.id}`, "https://anthropic-gateway.example/v1");
    assert.equal(resolved.baseUrl, "https://anthropic-gateway.example/v1");
    assert.ok(resolved.piModel);
    assert.equal(resolved.api, "anthropic-messages");
  });

  it("reports duplicate unqualified ids as ambiguous", () => {
    const models = [
      { ...MODEL_REGISTRY["gpt-4.1"]!, provider: "gateway-a" },
      { ...MODEL_REGISTRY["gpt-4.1"]!, provider: "gateway-b", baseUrl: "https://other.example/v1" },
    ];
    const match = findExactModelReferenceMatch("gpt-4.1", models);
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
    it("searchModels returns all models for an empty query", () => {
      const all = getAllModels();
      assert.equal(searchModels("").length, all.length);
      assert.equal(searchModels("   ").length, all.length);
    });
  
    it("searchModels finds models by exact substring in id", () => {
      const results = searchModels("deepseek-v4");
      assert.ok(results.length >= 2);
      assert.ok(results.every((m) => m.id.includes("deepseek-v4")));
    });
  
    it("searchModels finds models by provider substring", () => {
      const results = searchModels("anthropic");
      assert.ok(results.length > 0);
      assert.ok(results.every((m) => m.provider === "anthropic" || m.id.includes("anthropic") || m.name.toLowerCase().includes("anthropic")));
    });
  
    it("searchModels fuzzy-matches a typo ('agens' → agnes-ai models)", () => {
      const results = searchModels("agens");
      assert.ok(results.length > 0, "Expected fuzzy matches for 'agens'");
      assert.ok(results.some((m) => m.provider === "agnes-ai"), "Expected at least one agnes-ai model");
    });
  
    it("searchModels ranks exact prefix matches before fuzzy matches", () => {
      // 'deepseek' is a substring of 'deepseek-v4-flash' — should outrank anything fuzzy
      const results = searchModels("deepseek");
      assert.ok(results.length > 0);
      // All results that don't include 'deepseek' in id/name/provider should come after those that do
      const substringIdx = results.findIndex((m) => m.id.includes("deepseek") || m.provider.includes("deepseek"));
      assert.equal(substringIdx, 0, "Substring match should be ranked first");
    });
  
    it("searchModels returns empty for a completely unrelated query", () => {
      const results = searchModels("zzzzzzzzzzzzzzzzz");
      assert.equal(results.length, 0);
    });
  
    it("searchModels supports multi-word AND queries", () => {
      // Both 'deepseek' and 'flash' must appear
      const results = searchModels("deepseek flash");
      assert.ok(results.length > 0);
      assert.ok(results.every((m) =>
        (`${m.provider}/${m.id} ${m.name}`).toLowerCase().includes("flash") &&
        (`${m.provider}/${m.id} ${m.name}`).toLowerCase().includes("deepseek"),
      ));
    });
  });
});
