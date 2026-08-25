/**
 * Single source of truth for the ordered thinking-effort levels.
 *
 * Both the provider layer (`pi-ai/models.ts`) and the app layer
 * (`think-intensity.ts`) derive their support/clamp rules from here, so a new
 * level (e.g. "ultra") only needs to be added to this list.
 */

import type { ModelThinkingLevel, ThinkingLevel } from "./types.ts";

/**
 * Ordered effort levels, lowest to highest. "off" is not an effort level but
 * is included so support/clamping can treat the full domain uniformly.
 */
export const ALL_THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
] as const;

/** Effort levels only, in ascending order ("off" excluded). */
export const THINKING_EFFORT_LEVELS: readonly ThinkingLevel[] = ALL_THINKING_LEVELS.filter(
	(level): level is ThinkingLevel => level !== "off",
);

/**
 * Effort levels that every provider can express directly. Extended levels
 * ("xhigh"/"max"/"ultra") fall back to "high" on such providers.
 */
export type BaseEffortLevel = Exclude<ThinkingLevel, "xhigh" | "max" | "ultra">;

export function toBaseEffortLevel(
	level: ThinkingLevel | undefined,
): BaseEffortLevel | undefined {
	if (level === undefined) return undefined;
	return requiresExplicitMapping(level) ? "high" : level as BaseEffortLevel;
}

/**
 * Demote "ultra" to "max" for wire formats whose effort field stops at max.
 */
export function demoteUltra(level: ThinkingLevel | undefined): Exclude<ThinkingLevel, "ultra"> | undefined {
	if (level === undefined) return undefined;
	return (level === "ultra" ? "max" : level) as Exclude<ThinkingLevel, "ultra">;
}

/**
 * Extended effort levels require an explicit provider mapping
 * (`thinkingLevelMap[level] !== undefined`); lower levels fall back to the
 * provider default when unmapped.
 */
export function requiresExplicitMapping(level: ModelThinkingLevel): boolean {
	return level === "xhigh" || level === "max" || level === "ultra";
}

export function isValidModelThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && (ALL_THINKING_LEVELS as readonly string[]).includes(value);
}

export function thinkingLevelIndex(level: ModelThinkingLevel): number {
	return ALL_THINKING_LEVELS.indexOf(level);
}

/**
 * Clamp a requested level against the available set using the shared order:
 * prefer the nearest higher supported level, then the nearest lower one,
 * otherwise the first available level.
 */
export function clampToAvailableLevels(
	requested: ModelThinkingLevel,
	isAvailable: (level: ModelThinkingLevel) => boolean,
): ModelThinkingLevel {
	if (isAvailable(requested)) return requested;

	const requestedIndex = thinkingLevelIndex(requested);
	if (requestedIndex < 0) return "off";

	for (let i = requestedIndex; i < ALL_THINKING_LEVELS.length; i++) {
		const candidate = ALL_THINKING_LEVELS[i];
		if (candidate && isAvailable(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = ALL_THINKING_LEVELS[i];
		if (candidate && isAvailable(candidate)) return candidate;
	}
	return "off";
}

/** Whether a model offers the given level according to its `thinkingLevelMap`. */
export function modelSupportsMappedLevel(
	reasoning: boolean,
	thinkingLevelMap: Partial<Record<ModelThinkingLevel, string | null>> | undefined,
	level: ModelThinkingLevel,
): boolean {
	if (!reasoning) return false;
	const mapped = thinkingLevelMap?.[level];
	if (mapped === null) return false;
	if (requiresExplicitMapping(level)) return mapped !== undefined;
	return true;
}

/** The human-readable label list shared by UI surfaces. */
export const THINKING_LEVEL_DISPLAY_LABELS: Readonly<Record<ModelThinkingLevel, string>> = {
	off: "关闭",
	minimal: "最小",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "极高",
	max: "最大",
	ultra: "超限",
};
