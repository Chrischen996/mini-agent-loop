// This module has no runtime or SDK dependencies so Web previews use the same serializer.
type ThinkingModel = { reasoning: boolean; thinkingLevelMap?: Partial<Record<string, string | null>> };
type ThinkingOptions = { reasoningEffort?: string };
type ChatTemplateKwargValue = string | number | boolean | null | { $var: "thinking.enabled" | "thinking.effort"; omitWhenOff?: boolean };
type OpenAICompletionsCompat = { thinkingFormat?: string; supportsReasoningEffort?: boolean; chatTemplateKwargs?: Record<string, ChatTemplateKwargValue> };
type ResolvedChatTemplateKwargValue = string | number | boolean | null;

/** Shared by native Pi and the agent's streaming/non-streaming gateway paths. */
export function applyCompletionsThinking(
  params: Record<string, unknown>,
  model: ThinkingModel,
  options: ThinkingOptions | undefined,
  compat: OpenAICompletionsCompat,
): void {
	if (compat.thinkingFormat === "zai" && model.reasoning) {
		const zaiParams = params as Omit<typeof params, "reasoning_effort"> & {
			thinking?: { type: "enabled" | "disabled"; clear_thinking?: boolean };
			reasoning_effort?: string;
		};
		zaiParams.thinking = options?.reasoningEffort ? { type: "enabled", clear_thinking: false } : { type: "disabled" };
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			const mappedEffort = model.thinkingLevelMap?.[options.reasoningEffort];
			const effort = mappedEffort === undefined ? options.reasoningEffort : mappedEffort;
			if (typeof effort === "string") {
				zaiParams.reasoning_effort = effort;
			}
		}
	} else if (compat.thinkingFormat === "qwen" && model.reasoning) {
		params.enable_thinking = !!options?.reasoningEffort;
	} else if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
		params.chat_template_kwargs = {
			enable_thinking: !!options?.reasoningEffort,
			preserve_thinking: true,
		};
	} else if (compat.thinkingFormat === "chat-template" && model.reasoning) {
		const chatTemplateKwargs = buildChatTemplateKwargs(model, options, compat);
		if (chatTemplateKwargs) {
			params.chat_template_kwargs = chatTemplateKwargs;
		}
	} else if (compat.thinkingFormat === "deepseek" && model.reasoning) {
		if (options?.reasoningEffort) {
			params.thinking = { type: "enabled" };
		} else if (model.thinkingLevelMap?.off !== null) {
			params.thinking = { type: "disabled" };
		}
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			params.reasoning_effort =
				model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		}
	} else if (compat.thinkingFormat === "openrouter" && model.reasoning) {
		// OpenRouter normalizes reasoning across providers via a nested reasoning object.
		const openRouterParams = params as typeof params & { reasoning?: { effort?: string } };
		if (options?.reasoningEffort) {
			openRouterParams.reasoning = {
				effort: model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort,
			};
		} else if (model.thinkingLevelMap?.off !== null) {
			openRouterParams.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
		}
	} else if (compat.thinkingFormat === "ant-ling" && model.reasoning && options?.reasoningEffort) {
		const effort = model.thinkingLevelMap?.[options.reasoningEffort];
		if (typeof effort === "string") {
			(params as typeof params & { reasoning?: { effort: string } }).reasoning = { effort };
		}
	} else if (compat.thinkingFormat === "together" && model.reasoning) {
		const togetherParams = params as Omit<typeof params, "reasoning_effort"> & {
			reasoning?: { enabled: boolean };
			reasoning_effort?: string;
		};
		togetherParams.reasoning = { enabled: !!options?.reasoningEffort };
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			togetherParams.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		}
	} else if (compat.thinkingFormat === "string-thinking" && model.reasoning) {
		const stringThinkingParams = params as typeof params & { thinking?: string };
		if (options?.reasoningEffort) {
			stringThinkingParams.thinking = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		} else if (model.thinkingLevelMap?.off !== null) {
			stringThinkingParams.thinking = model.thinkingLevelMap?.off ?? "none";
		}
	} else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
		// OpenAI-style reasoning_effort
		params.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
	} else if (!options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
		const offValue = model.thinkingLevelMap?.off;
		if (typeof offValue === "string") {
			params.reasoning_effort = offValue;
		}
	}

}

function buildChatTemplateKwargs(
	model: ThinkingModel,
	options: ThinkingOptions | undefined,
	compat: OpenAICompletionsCompat,
): Record<string, ResolvedChatTemplateKwargValue> | undefined {
	const kwargs: Record<string, ResolvedChatTemplateKwargValue> = {};

	for (const [key, value] of Object.entries(compat.chatTemplateKwargs ?? {})) {
		const resolved = resolveChatTemplateKwargValue(model, options, value);
		if (resolved !== undefined) {
			kwargs[key] = resolved;
		}
	}

	return Object.keys(kwargs).length > 0 ? kwargs : undefined;
}

function resolveChatTemplateKwargValue(
	model: ThinkingModel,
	options: ThinkingOptions | undefined,
	value: ChatTemplateKwargValue,
): ResolvedChatTemplateKwargValue | undefined {
	if (typeof value !== "object" || value === null) {
		return value;
	}

	const reasoningEffort = options?.reasoningEffort;
	if (!reasoningEffort && value.omitWhenOff) {
		return undefined;
	}
	if (value.$var === "thinking.enabled") {
		return !!reasoningEffort;
	}

	const mappedValue = reasoningEffort ? model.thinkingLevelMap?.[reasoningEffort] : model.thinkingLevelMap?.off;
	return mappedValue === undefined ? reasoningEffort : typeof mappedValue === "string" ? mappedValue : undefined;
}

