import type { CustomModelDefinition, ModelProviderProtocol, ThinkingCompat, ThinkingLevel } from "../types/api.ts";

export const thinkingLevels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export type ThinkingContext = {
  protocol: ModelProviderProtocol;
  baseUrl: string;
  compat: ThinkingCompat;
};

export type ThinkingSetup = {
  efforts: Partial<Record<ThinkingLevel, string | null>>;
  defaultLevel: ThinkingLevel;
  compat: ThinkingCompat;
};

export type ThinkingDraft = ThinkingSetup & { automaticThinking: boolean };

/** UI defaults for a new reasoning configuration; existing custom mappings are preserved. */
export function automaticThinking(context: ThinkingContext, modelId: string): ThinkingSetup {
  let deepseekHost = false;
  let openrouterHost = false;
  try {
    const hostname = new URL(context.baseUrl).hostname.toLowerCase();
    deepseekHost = hostname === "deepseek.com" || hostname.endsWith(".deepseek.com");
    openrouterHost = hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai");
  } catch { /* The URL may still be incomplete while typing. */ }
  const deepseekModel = /(^|[\/_-])deepseek([\/_-]|$)/i.test(modelId);
  const inferredFormat = context.protocol !== "openai-completions" ? undefined : openrouterHost ? "openrouter" : deepseekHost || deepseekModel ? "deepseek" : undefined;
  const format = context.compat.thinkingFormat ?? inferredFormat;
  const switchOnly = context.compat.supportsReasoningEffort === false || format === "qwen" || format === "qwen-chat-template";
  const simpleLevels = context.protocol === "openai-completions" && (format === "deepseek" || switchOnly);
  return {
    efforts: switchOnly ? { off: null, high: "high" } : simpleLevels ? { off: null, high: "high", max: "max" } : { off: null, low: "low", medium: "medium", high: "high" },
    defaultLevel: simpleLevels ? "high" : "medium",
    compat: inferredFormat && !context.compat.thinkingFormat ? { thinkingFormat: inferredFormat } : {},
  };
}

export function resolveThinking(draft: ThinkingDraft, context: ThinkingContext, modelId: string): ThinkingSetup {
  if (!draft.automaticThinking) return draft;
  const automatic = automaticThinking(context, modelId);
  return {
    ...automatic,
    defaultLevel: Object.hasOwn(automatic.efforts, draft.defaultLevel) ? draft.defaultLevel : automatic.defaultLevel,
  };
}

export function thinkingDraft(model: CustomModelDefinition, context: ThinkingContext): ThinkingDraft {
  const automatic = automaticThinking(context, model.id);
  const efforts = model.reasoningEfforts || automatic.efforts;
  const compat = model.compat ?? {};
  const matchesAutomatic = thinkingLevels.every((level) => Object.hasOwn(efforts, level) === Object.hasOwn(automatic.efforts, level) && efforts[level] === automatic.efforts[level])
    && compat.thinkingFormat === automatic.compat.thinkingFormat && compat.supportsReasoningEffort === automatic.compat.supportsReasoningEffort;
  return {
    efforts,
    defaultLevel: model.defaultThinkingLevel ?? (Object.hasOwn(efforts, "medium") ? "medium" : thinkingLevels.find((level) => level !== "off" && Object.hasOwn(efforts, level)) ?? automatic.defaultLevel),
    compat,
    automaticThinking: matchesAutomatic || (!model.reasoningEfforts && Object.keys(compat).length === 0),
  };
}
