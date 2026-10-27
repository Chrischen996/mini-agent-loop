import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { PERPLEXITY_MODELS } from "./perplexity.models.ts";

export function perplexityProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "perplexity",
		name: "Perplexity",
		baseUrl: "https://api.perplexity.ai",
		auth: { apiKey: envApiKeyAuth("Perplexity API key", ["PERPLEXITY_API_KEY"]) },
		models: Object.values(PERPLEXITY_MODELS),
		api: openAICompletionsApi(),
	});
}
