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
      TOKENROUTER_API_KEY: "test",
    };
    assert.deepEqual(
      [...new Set(getAvailableModels(env).map((model) => model.provider))],
      ["agnes-ai", "deepseek", "google", "groq", "mistral", "moonshotai", "moonshotai-cn", "openai", "openai-codex", "openrouter", "xai", "tokenrouter"],
    );
    assert.equal(getAllModels().length, 1078);
    assert.ok(getAllModels().every((model) => model.contextWindow > 0 && model.maxTokens > 0));
  });

  it("registers both regional Kimi K3 models with their documented metadata", () => {
    const models = getAllModels().filter(
      (model) => model.id === "kimi-k3" && (model.provider === "moonshotai" || model.provider === "moonshotai-cn"),
    );
    const qualifiedReferences = models.map((model) => `${model.provider}/${model.id}`).sort();
    assert.deepEqual(qualifiedReferences, ["moonshotai-cn/kimi-k3", "moonshotai/kimi-k3"]);

    const byProvider = new Map(models.map((model) => [model.provider, model]));
    assert.equal(byProvider.get("moonshotai")?.baseUrl, "https://api.moonshot.ai/v1");
    assert.equal(byProvider.get("moonshotai-cn")?.baseUrl, "https://api.moonshot.cn/v1");

    for (const model of models) {
      assert.equal(model.name, "Kimi K3");
      assert.equal(model.contextWindow, 1048576);
      assert.equal(model.maxTokens, 131072);
      assert.equal(model.reasoning, true);
      assert.deepEqual(model.capabilities.input, ["text", "image"]);
      assert.equal(model.capabilities.tools, true);
      assert.deepEqual(model.cost, {
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 0,
      });
      assert.deepEqual(model.compat, {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        maxTokensField: "max_completion_tokens",
        supportsStrictMode: false,
        thinkingFormat: "openai",
      });
      assert.deepEqual(model.thinkingLevelMap, {
        off: null,
        minimal: "low",
        low: "low",
        medium: "high",
        high: "high",
        xhigh: "max",
        max: "max",
      });
    }

    const searchReferences = searchModels("k3").map((model) => `${model.provider}/${model.id}`);
    for (const reference of qualifiedReferences) {
      assert.ok(searchReferences.includes(reference), `Expected search results to include ${reference}`);
    }
    for (const reference of qualifiedReferences) {
      const resolved = resolveModel(reference);
      assert.equal(`${resolved.provider}/${resolved.id}`, reference);
    }
  });

  it("registers TokenRouter's fixed Kimi K3 Free route with compatible metadata", () => {
    const models = getAllModels().filter(
      (model) => model.provider === "tokenrouter" && model.id === "kimi-k3-free",
    );
    assert.equal(models.length, 1);
    const model = models[0];
    assert.ok(model);
    assert.equal(model.provider, "tokenrouter");
    assert.equal(model.baseUrl, "https://api.tokenrouter.io/v1");
    assert.deepEqual(model.apiKeyEnv, ["TOKENROUTER_API_KEY"]);
    assert.deepEqual(model.capabilities.input, ["text"]);
    assert.equal(model.capabilities.tools, true);
    assert.equal(model.reasoning, false);
    assert.equal(model.contextWindow, 128000);
    assert.equal(model.maxTokens, 16384);
    assert.deepEqual(model.cost, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    assert.deepEqual(model.compat, {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
      thinkingFormat: "openai",
    });

    const available = getAvailableModels({ TOKENROUTER_API_KEY: "test" });
    assert.ok(available.some((item) => item.provider === "tokenrouter" && item.id === "kimi-k3-free"));

    const qualifiedReference = "tokenrouter/kimi-k3-free";
    assert.ok(searchModels("kimi-k3-free").some(
      (item) => `${item.provider}/${item.id}` === qualifiedReference,
    ));

    const resolved = resolveModel(qualifiedReference);
    assert.equal(resolved.provider, "tokenrouter");
    assert.equal(resolved.id, "kimi-k3-free");
    assert.equal(resolved.baseUrl, "https://api.tokenrouter.io/v1");
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
  });

  it("searchModels returns all models for an empty query", () => {
      const all = getAllModels();
      assert.equal(searchModels("").length, all.length);
      assert.equal(searchModels("   ").length, all.length);
    });
  
    it("searchModels finds models by exact substring in id", () => {
      const results = searchModels("deepseek-v4");
      assert.ok(results.length >= 2);
      assert.ok(results.every((m) => m.id.toLowerCase().includes("deepseek-v4")));
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
