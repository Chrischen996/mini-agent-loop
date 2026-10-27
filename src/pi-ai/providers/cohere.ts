import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { COHERE_MODELS } from "./cohere.models.ts";

export function cohereProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "cohere",
		name: "Cohere",
		baseUrl: "https://api.cohere.com/compatibility/v1",
		auth: { apiKey: envApiKeyAuth("Cohere API key", ["COHERE_API_KEY"]) },
		models: Object.values(COHERE_MODELS),
		api: openAICompletionsApi(),
	});
}
