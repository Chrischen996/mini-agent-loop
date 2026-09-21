import type { Model } from "./pi-ai/types.ts";

const GPT6_ASTRA_COMPAT = {
  supportsToolSearch: true,
} satisfies NonNullable<Model<"openai-responses">["compat"]>;

const GPT6_ASTRA_COST = {
  input: 2.5,
  output: 15,
  cacheRead: 0.25,
  cacheWrite: 3.125,
  tiers: [{
    inputTokensAbove: 272000,
    input: 5,
    output: 22.5,
    cacheRead: 0.5,
    cacheWrite: 6.25,
  }],
};

const GPT6_ASTRA_API_THINKING_LEVEL_MAP = {
  off: "none",
  xhigh: "xhigh",
  max: "max",
};

const GPT6_ASTRA_CODEX_THINKING_LEVEL_MAP = {
  xhigh: "xhigh",
  max: "max",
  minimal: "low",
};

/**
 * Project-owned overlay for GPT-6 Astra. The generated pi-ai catalog does not
 * include this model yet; mergeBuiltInModels keeps upstream entries if the
 * same provider/id lands in a later generated snapshot.
 */
export const GPT6_ASTRA_MODELS = [
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    compat: GPT6_ASTRA_COMPAT,
    reasoning: true,
    thinkingLevelMap: GPT6_ASTRA_API_THINKING_LEVEL_MAP,
    input: ["text", "image"],
    cost: GPT6_ASTRA_COST,
    contextWindow: 272000,
    maxTokens: 128000,
  } satisfies Model<"openai-responses">,
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    compat: GPT6_ASTRA_COMPAT,
    reasoning: true,
    thinkingLevelMap: GPT6_ASTRA_CODEX_THINKING_LEVEL_MAP,
    input: ["text", "image"],
    cost: GPT6_ASTRA_COST,
    contextWindow: 372000,
    maxTokens: 128000,
  } satisfies Model<"openai-codex-responses">,
];
