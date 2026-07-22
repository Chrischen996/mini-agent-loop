import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { QWEN_MODELS } from "./qwen.models.ts";

export function qwenProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "qwen",
		name: "Qwen (DashScope)",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		auth: { apiKey: envApiKeyAuth("Qwen/DashScope API key", ["DASHSCOPE_API_KEY"]) },
		models: Object.values(QWEN_MODELS),
		api: openAICompletionsApi(),
	});
}
