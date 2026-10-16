import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { automaticThinking, resolveThinking, thinkingDraft, type ThinkingContext } from "../apps/web/src/lib/custom-model-thinking.ts";
import { customProviderModels } from "../src/models.ts";
import { validateCustomProvider } from "../src/profile-store.ts";
import { applyCompletionsThinking } from "../src/pi-ai/completions-thinking.ts";

const gateway: ThinkingContext = { protocol: "openai-completions", baseUrl: "https://gateway.example/v1", compat: {} };

describe("simple Web thinking setup", () => {
  it("creates a usable DeepSeek request without manually entering protocol fields", () => {
    for (const [baseUrl, id] of [["https://api.deepseek.com/v1", "my-reasoner"], [gateway.baseUrl, "deepseek-reasoner"]]) {
      const setup = automaticThinking({ ...gateway, baseUrl: baseUrl! }, id!);
      const provider = validateCustomProvider("team", {
        baseUrl, protocol: gateway.protocol, apiKey: "test",
        models: [{ id, reasoningEfforts: setup.efforts, defaultThinkingLevel: setup.defaultLevel, compat: setup.compat }],
      });
      const model = customProviderModels({ team: provider })[0]!;
      const body = {};
      applyCompletionsThinking(body, model, { reasoningEffort: setup.defaultLevel }, { supportsReasoningEffort: true, ...setup.compat });
      assert.deepEqual(body, { thinking: { type: "enabled" }, reasoning_effort: "high" });
      assert.equal(setup.efforts.max, "max");
    }
  });

  it("uses the endpoint format for DeepSeek models served by OpenRouter", () => {
    const setup = automaticThinking({ ...gateway, baseUrl: "https://openrouter.ai/api/v1" }, "deepseek/deepseek-r1");
    const body = {};
    applyCompletionsThinking(body, { reasoning: true }, { reasoningEffort: setup.defaultLevel }, { supportsReasoningEffort: true, ...setup.compat });
    assert.deepEqual(body, { reasoning: { effort: "medium" } });
  });

  it("keeps saved custom mappings and their default when editing in the simple form", () => {
    const context = { ...gateway, compat: { thinkingFormat: "deepseek" as const } };
    const saved = { id: "custom-think", reasoningEfforts: { off: null, high: "high", max: "ultra" }, defaultThinkingLevel: "max" as const, compat: { supportsReasoningEffort: true } };
    const draft = thinkingDraft(saved, context);
    assert.equal(draft.automaticThinking, false);
    const resolved = resolveThinking(draft, context, saved.id);
    assert.deepEqual(resolved.efforts, saved.reasoningEfforts);
    assert.equal(resolved.defaultLevel, "max");
    assert.deepEqual(resolved.compat, saved.compat);
  });

  it("adapts automatic defaults when a model ID changes while retaining a supported choice", () => {
    const draft = thinkingDraft({ id: "my-model" }, gateway);
    const deepseek = resolveThinking(draft, gateway, "deepseek-reasoner");
    assert.equal(deepseek.defaultLevel, "high");
    const selectedOff = resolveThinking({ ...draft, defaultLevel: "off" }, gateway, "deepseek-reasoner");
    assert.equal(selectedOff.defaultLevel, "off");
    const responses = resolveThinking(draft, { ...gateway, protocol: "openai-responses" }, "deepseek-reasoner");
    assert.deepEqual(responses.compat, {});
    assert.equal(responses.defaultLevel, "medium");
  });
});
