import { openAICompletionsApi } from "./pi-ai/api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "./pi-ai/auth/helpers.ts";
import { createProvider, type Provider } from "./pi-ai/models.ts";
import type { Model } from "./pi-ai/types.ts";

const ORCAROUTER_BASE_URL = "https://api.orcarouter.ai/v1";

const ORCAROUTER_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
  supportsStrictMode: false,
  thinkingFormat: "openai",
} satisfies NonNullable<Model<"openai-completions">["compat"]>;

/**
 * Project-owned OrcaRouter free-tier routes. OrcaRouter is an OpenAI-compatible
 * gateway (keys look like `sk-orca-...`) that routes requests across upstream
 * providers. Only the free routes are listed here, matching
 * https://www.orcarouter.ai/models?price=free.
 */
export const ORCAROUTER_MODELS = [
  {
    id: "orcarouter/free",
    name: "OrcaRouter Free Router",
    api: "openai-completions",
    provider: "orcarouter",
    baseUrl: ORCAROUTER_BASE_URL,
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    compat: ORCAROUTER_COMPAT,
  },
  {
    id: "deepseek/deepseek-v4-flash-free",
    name: "DeepSeek V4 Flash Free",
    api: "openai-completions",
    provider: "orcarouter",
    baseUrl: ORCAROUTER_BASE_URL,
    reasoning: false,
    input: ["text"],
    contextWindow: 1048576,
    maxTokens: 16384,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    compat: ORCAROUTER_COMPAT,
  },
  {
    id: "tencent/hy3-free",
    name: "Tencent Hy3 Free",
    api: "openai-completions",
    provider: "orcarouter",
    baseUrl: ORCAROUTER_BASE_URL,
    reasoning: false,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 16384,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    compat: ORCAROUTER_COMPAT,
  },
  {
    id: "z-ai/glm-5.3-flash-free",
    name: "GLM 5.3 Flash Free",
    api: "openai-completions",
    provider: "orcarouter",
    baseUrl: ORCAROUTER_BASE_URL,
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 16384,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    compat: ORCAROUTER_COMPAT,
  },
] satisfies readonly Model<"openai-completions">[];

export function orcarouterProvider(): Provider<"openai-completions"> {
  return createProvider({
    id: "orcarouter",
    name: "OrcaRouter",
    baseUrl: ORCAROUTER_BASE_URL,
    auth: { apiKey: envApiKeyAuth("OrcaRouter API key", ["ORCAROUTER_API_KEY"]) },
    models: ORCAROUTER_MODELS,
    api: openAICompletionsApi(),
  });
}
