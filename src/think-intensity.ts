// Provider-neutral thinking level configuration and interactive level controls.

import type { LlmConfig } from "./llm/config.ts";
import type { ModelThinkingLevel } from "./pi-ai/types.ts";

export type ThinkingIntensity = "low" | "med" | "high" | "xhigh";

/** The default user-facing intensity when no explicit setting is present. */
export const DEFAULT_THINKING_INTENSITY: ThinkingIntensity = "med";

export const THINKING_INTENSITY_TO_MODEL_LEVEL: Readonly<Record<ThinkingIntensity, ModelThinkingLevel>> = {
  low: "low",
  med: "medium",
  high: "high",
  xhigh: "xhigh",
};

/** Only a leading, standalone command changes the request. */
const THINKING_COMMAND_RE = /^\s*\/think:(low|med|high|xhigh)(?=$|\s)/i;

export type ThinkingIntensityPrompt = {
  intensity: ThinkingIntensity | null;
  prompt: string;
};

function normalizeIntensity(value: unknown): ThinkingIntensity | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return isValidIntensity(normalized) ? normalized : null;
}

function findThinkingCommand(userMessage: string): RegExpMatchArray | null {
  return userMessage.match(THINKING_COMMAND_RE);
}

/** Parse a leading standalone `/think:<level>` command. */
export function parseThinkingIntensityCommand(userMessage: string): ThinkingIntensity | null {
  return normalizeIntensity(findThinkingCommand(userMessage)?.[1]);
}

/** Remove a leading thinking command while preserving the actual user prompt. */
export function stripThinkingIntensityCommands(userMessage: string): string {
  return userMessage.replace(THINKING_COMMAND_RE, "").trim();
}

export const parseThinkingIntensity = parseThinkingIntensityCommand;
export const stripThinkingIntensityCommand = stripThinkingIntensityCommands;
export const cleanThinkingPrompt = stripThinkingIntensityCommands;

/** Parse and clean a prompt in one operation. */
export function parseThinkingIntensityPrompt(userMessage: string): ThinkingIntensityPrompt {
  const intensity = parseThinkingIntensityCommand(userMessage);
  return {
    intensity,
    prompt: stripThinkingIntensityCommands(userMessage),
  };
}

export const parseThinkingIntensityInput = parseThinkingIntensityPrompt;

export function intensityToModelThinkingLevel(intensity: ThinkingIntensity): ModelThinkingLevel {
  return THINKING_INTENSITY_TO_MODEL_LEVEL[intensity];
}

export const thinkingIntensityToModelLevel = intensityToModelThinkingLevel;
export const mapThinkingIntensityToModelLevel = intensityToModelThinkingLevel;

/** Return a model level that can actually be used by the current model. */
export function normalizeThinkingLevelForModel(
  reasoning: boolean,
  level: ModelThinkingLevel,
): ModelThinkingLevel {
  return reasoning ? level : "off";
}

export type ThinkingLlmConfig = LlmConfig & { thinkingLevel: ModelThinkingLevel };

/**
 * Stable UI order used by the direct effort shortcuts. Provider/model catalogs
 * can narrow this list through `thinkingLevelMap`.
 */
export const THINKING_LEVEL_ORDER: readonly ModelThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function modelSupportsLevel(
  config: Pick<LlmConfig, "reasoning" | "piModel">,
  level: ModelThinkingLevel,
): boolean {
  if (!config.reasoning) return level === "off";
  const levelMap = config.piModel?.thinkingLevelMap;
  if (!levelMap) return level !== "off";
  return Object.prototype.hasOwnProperty.call(levelMap, level);
}

/** Return the effort levels that can be selected for the active model. */
export function getThinkingLevelChoices(
  config: Pick<LlmConfig, "reasoning" | "piModel">,
): ModelThinkingLevel[] {
  if (!config.reasoning) return ["off"];
  const mapped = THINKING_LEVEL_ORDER.filter((level) => modelSupportsLevel(config, level));
  return mapped.length > 0 ? [...mapped] : ["medium"];
}

/** Move one effort step without changing provider or model. */
export function cycleThinkingLevel(
  config: Pick<LlmConfig, "reasoning" | "piModel" | "thinkingLevel">,
  direction: "increase" | "decrease",
  options: { wrap?: boolean } = {},
): ModelThinkingLevel {
  const choices = getThinkingLevelChoices(config);
  if (choices.length <= 1) return choices[0] ?? "off";

  const current = config.thinkingLevel ?? (config.reasoning ? "medium" : "off");
  const index = choices.indexOf(current);
  if (index < 0) return direction === "increase" ? choices[0]! : choices.at(-1)!;
  const nextIndex = options.wrap
    ? (index + (direction === "increase" ? 1 : -1) + choices.length) % choices.length
    : direction === "increase"
      ? Math.min(choices.length - 1, index + 1)
      : Math.max(0, index - 1);
  return choices[nextIndex]!;
}

export function thinkingLevelToDisplay(level: ModelThinkingLevel): string {
  const labels: Record<ModelThinkingLevel, string> = {
    off: "关闭",
    minimal: "最小",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
    max: "最大",
  };
  return labels[level];
}

/** Apply an intensity to the current model without changing provider/model. */
export function buildIntenseLlm(base: LlmConfig, intensity: ThinkingIntensity): ThinkingLlmConfig {
  return {
    ...base,
    thinkingLevel: normalizeThinkingLevelForModel(
      base.reasoning,
      intensityToModelThinkingLevel(intensity),
    ),
  };
}

/** Apply a provider-neutral level to the current model without model switching. */
export function withThinkingLevel(base: LlmConfig, level: ModelThinkingLevel): ThinkingLlmConfig {
  return {
    ...base,
    thinkingLevel: normalizeThinkingLevelForModel(base.reasoning, level),
  };
}

export function intensityToDisplay(intensity: ThinkingIntensity): string {
  const map: Record<ThinkingIntensity, string> = {
    low: "轻量 (Low)",
    med: "平衡 (Med)",
    high: "深度 (High)",
    xhigh: "极致 (X-High)",
  };
  return map[intensity];
}

export function getIntensities(): ThinkingIntensity[] {
  return ["low", "med", "high", "xhigh"];
}

export function isValidIntensity(test: unknown): test is ThinkingIntensity {
  return test === "low" || test === "med" || test === "high" || test === "xhigh";
}

/** Resolve the default intensity from the legacy environment variable. */
export function getDefaultIntensity(env: NodeJS.ProcessEnv = process.env): ThinkingIntensity {
  const raw = env.DEFAULT_THINKING_INTENSITY?.trim().toLowerCase();
  if (raw === "medium") return "med";
  return normalizeIntensity(raw) ?? DEFAULT_THINKING_INTENSITY;
}

export function getDefaultThinkingLevel(env: NodeJS.ProcessEnv = process.env): ModelThinkingLevel {
  return intensityToModelThinkingLevel(getDefaultIntensity(env));
}

export const getDefaultModelThinkingLevel = getDefaultThinkingLevel;
