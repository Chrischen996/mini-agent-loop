import type { Model } from "./pi-ai/types.ts";

const KIMI_K3_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  maxTokensField: "max_completion_tokens",
  supportsStrictMode: false,
  thinkingFormat: "openai",
} satisfies NonNullable<Model<"openai-completions">["compat"]>;

const KIMI_K3_THINKING_LEVEL_MAP = {
  off: null,
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
};

export const KIMI_K3_MODELS = [
  {
    id: "kimi-k3",
    name: "Kimi K3",
    api: "openai-completions",
    provider: "moonshotai",
    baseUrl: "https://api.moonshot.ai/v1",
    reasoning: true,
    thinkingLevelMap: KIMI_K3_THINKING_LEVEL_MAP,
    input: ["text", "image"],
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 0,
    },
    contextWindow: 1048576,
    maxTokens: 131072,
    compat: KIMI_K3_COMPAT,
  },
  {
    id: "kimi-k3",
    name: "Kimi K3",
    api: "openai-completions",
    provider: "moonshotai-cn",
    baseUrl: "https://api.moonshot.cn/v1",
    reasoning: true,
    thinkingLevelMap: KIMI_K3_THINKING_LEVEL_MAP,
    input: ["text", "image"],
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 0,
    },
    contextWindow: 1048576,
    maxTokens: 131072,
    compat: KIMI_K3_COMPAT,
  },
] satisfies readonly Model<"openai-completions">[];
