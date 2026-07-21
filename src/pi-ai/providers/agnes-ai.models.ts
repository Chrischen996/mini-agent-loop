import type { Model } from "../types.ts";

export const AGNES_AI_MODELS = {
	"agnes-2.0-flash": {
		id: "agnes-2.0-flash",
		name: "Agnes 2.0 Flash",
		api: "openai-completions",
		provider: "agnes-ai",
		baseUrl: "https://apihub.agnes-ai.com/v1",
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "chat-template",
			chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
		},
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 524288,
		maxTokens: 65536,
	} satisfies Model<"openai-completions">,
	"agnes-2.5-flash": {
		id: "agnes-2.5-flash",
		name: "Agnes 2.5 Flash (preview)",
		api: "openai-completions",
		provider: "agnes-ai",
		baseUrl: "https://apihub.agnes-ai.com/v1",
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "chat-template",
			chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
		},
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 524288,
		maxTokens: 65536,
	} satisfies Model<"openai-completions">,
} as const;
