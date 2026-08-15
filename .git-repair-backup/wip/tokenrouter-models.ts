import { openAICompletionsApi } from "./pi-ai/api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "./pi-ai/auth/helpers.ts";
import { createProvider, type Provider } from "./pi-ai/models.ts";
import type { Model } from "./pi-ai/types.ts";

const TOKENROUTER_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
  supportsStrictMode: false,
  thinkingFormat: "openai",
} satisfies NonNullable<Model<"openai-completions">["compat"]>;

export const TOKENROUTER_MODELS = [
  {
    id: "kimi-k3-free",
    name: "Kimi K3 Free (TokenRouter)",
    api: "openai-completions",
    provider: "tokenrouter",
    baseUrl: "https://api.tokenrouter.io/v1",
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
    compat: TOKENROUTER_COMPAT,
  },
] satisfies readonly Model<"openai-completions">[];

export function tokenrouterProvider(): Provider<"openai-completions"> {
  return createProvider({
    id: "tokenrouter",
    name: "TokenRouter",
    baseUrl: "https://api.tokenrouter.io/v1",
    auth: { apiKey: envApiKeyAuth("TokenRouter API key", ["TOKENROUTER_API_KEY"]) },
    models: TOKENROUTER_MODELS,
    api: openAICompletionsApi(),
  });
}
