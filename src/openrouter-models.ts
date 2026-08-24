import type { Model } from "./pi-ai/types.ts";

const OPENROUTER_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  maxTokensField: "max_tokens",
  supportsStrictMode: false,
  thinkingFormat: "openai",
} satisfies NonNullable<Model<"openai-completions">["compat"]>;

export const OPENROUTER_MODELS = [
  {
    id: "ox-alpha",
    name: "Ox Alpha",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    contextWindow: 1000000,
    maxTokens: 131072,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    compat: OPENROUTER_COMPAT,
  },
] satisfies readonly Model<"openai-completions">[];
