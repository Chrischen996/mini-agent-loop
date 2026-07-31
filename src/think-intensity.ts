// src/think-intensity.ts — Thinking intensity configuration and command parsing

import type { LlmConfig } from "./llm/config.ts";
import { getAvailableModels, resolveModel, type ModelRef } from "./models.ts";

export type ThinkingIntensity = "low" | "med" | "high" | "xhigh";

/** 
 * Think intensity profile: maps a level to partial LlmConfig fields.
 * The actual merge with provider/keys/baseUrl happens at runtime.
 */
const INTENSITY_MAP: Record<ThinkingIntensity, Omit<LlmConfig, "apiKey" | "baseUrl" | "provider"> & { model: string }> = {
  low: {
    model: "gpt-4o-mini",
    provider: "",
    baseUrl: "",
    contextWindow: 128000,
    maxTokens: 4096,
    capabilities: { reasoning: false, imageInput: true },
    imagePolicy: "allowed",
    toolCallFormat: "openai",
    reasoning: false,
  },
  med: {
    model: "gpt-4o",
    provider: "",
    baseUrl: "",
    contextWindow: 128000,
    maxTokens: 8192,
    capabilities: { reasoning: true, imageInput: true },
    imagePolicy: "allowed",
    toolCallFormat: "openai",
    reasoning: true,
  },
  high: {
    model: "claude-3-5-sonnet-20250226",
    provider: "",
    baseUrl: "",
    contextWindow: 200000,
    maxTokens: 32768,
    capabilities: { reasoning: true, imageInput: true },
    imagePolicy: "allowed",
    toolCallFormat: "openai",
    reasoning: true,
  },
  xhigh: {
    model: "claude-3-opus-20250226",
    provider: "",
    baseUrl: "",
    contextWindow: 200000,
    maxTokens: 65536,
    capabilities: { reasoning: true, imageInput: true },
    imagePolicy: "allowed",
    toolCallFormat: "openai",
    reasoning: true,
  },
};

/**
 * Parse a user message for thinking intensity commands.
 * Recognizes: /think:low, /think:med, /think:high, /think:xhigh
 * Also accepts shorthand: :low, :med, etc. when prefixed with slash.
 * Returns the intensity if matched, otherwise null.
 */
export function parseThinkingIntensityCommand(userMessage: string): ThinkingIntensity | null {
  const lower = userMessage.toLowerCase();

  // Check for /think:X pattern first (explicit)
  if (lower.includes("/think:xhigh")) return "xhigh" as ThinkingIntensity;
  if (lower.includes("/think:high")) return "high" as ThinkingIntensity;
  if (lower.includes(":mid") || lower.includes("/think:med")) return "med" as ThinkingIntensity;
  if (lower.includes("/think:low")) return "low" as ThinkingIntensity;

  // Shorthand patterns after slash or colon
  if (lower.match(/\b:t:xhigh\b/)) return "xhigh" as ThinkingIntensity;
  if (lower.match(/\b:t:high\b/)) return "high" as ThinkingIntensity;
  if (lower.match(/\b:t:med\b/) || lower.match(/\b:m:med\b/)) return "med" as ThinkingIntensity;
  if (lower.match(/\b:t:low\b/)) return "low" as ThinkingIntensity;

  return null;
}

/**
 * Build a new LlmConfig by merging the base config with intensity overrides.
 * Only the fields defined in INTENSITY_MAP are replaced; apiKey, provider,
 * baseUrl, and other runtime-sensitive fields are preserved from the base.
 */
export function buildIntenseLlm(base: LlmConfig, intensity: ThinkingIntensity): LlmConfig {
  const override = INTENSITY_MAP[intensity] as Partial<LlmConfig>;
  // Merge: keep base's provider/apiKey/BaseUrl, replace intensity-specific fields
  return {
    ...base,
    ...override,
  };
}

/**
 * Get the display name for an intensity level.
 */
export function intensityToDisplay(intensity: ThinkingIntensity): string {
  const map: Record<ThinkingIntensity, string> = {
    low: "轻量 (Low)",
    med: "平衡 (Med)",
    high: "深度 (High)",
    xhigh: "极致 (X-High)",
  };
  return map[intensity] || intensity;
}

/**
 * Get all available intensities supported.
 */
export function getIntensities(): ThinkingIntensity[] {
  return Object.keys(INTENSITY_MAP).filter((k): k is ThinkingIntensity => ["low", "med", "high", "xhigh"].includes(k as any)) as ThinkingIntensity[];
}

/**
 * Check if a given string is a valid intensity level.
 */
export function isValidIntensity(test: unknown): test is ThinkingIntensity {
  return ["low", "med", "high", "xhigh"].includes(test as string);
}

/**
 * Default intensity on server start (matching current env config).
 */
export function getDefaultIntensity(): ThinkingIntensity {
  const def = process.env.DEFAULT_THINKING_INTENSITY;
  if (def && isValidIntensity(def)) return def;
  return "med"; // default balance
}
