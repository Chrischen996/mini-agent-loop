/**
 * LLM configuration: types, env/profile loading, model switching.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  applyRelayIfMatched,
  loadRelayRegistryFromEnv,
  type RelayRegistry,
} from "../relay.ts";
import { getActiveProfile, loadProfileStoreSync } from "../profile-store.ts";
import {
  getAvailableModels,
  parseImagePolicy,
  resolveModel,
  type ImagePolicy,
  type ModelCapabilities,
  type ModelRef,
} from "../models.ts";
import type { ToolCallFormat } from "../hermes/types.ts";
import type { Tool } from "../tools/types.ts";
import type { AgentMessage, AssistantMessage } from "../types.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export type LlmConfig = {
  apiKey: string;
  provider: string;
  baseUrl: string;
  model: string;
  capabilities: ModelCapabilities;
  contextWindow: number;
  maxTokens: number;
  timeoutMs?: number;
  piModel?: ModelRef["piModel"];
  reasoning: boolean;
  imagePolicy: ImagePolicy;
  /**
   * The wire format used for tool calling.
   * - `"openai"` (default) — standard OpenAI Chat Completions `tool_calls`
   * - `"hermes"` — Hermes XML `<tool_call>` blocks in assistant text
   */
  toolCallFormat: ToolCallFormat;
  /**
   * Optional dynamic API key resolver.  When present, called before every LLM
   * request; the returned value overrides the static `apiKey` field.
   *
   * Use cases:
   * - OAuth / short-lived token refresh
   * - Key-pool round-robin rotation (anti-rate-limit)
   * - Relay / gateway with a different auth scheme than the upstream provider
   */
  getApiKey?: () => string | Promise<string>;
};

export type ChatFn = (
  config: LlmConfig,
  messages: AgentMessage[],
  tools?: Tool[],
) => Promise<AssistantMessage>;

export type ModelSwitchOverrides = {
  baseUrl?: string;
  apiKey?: string;
};

// ─── Timeout / signal utilities ──────────────────────────────────────────────

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

function configuredTimeout(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1_000 ? Math.floor(value) : DEFAULT_REQUEST_TIMEOUT_MS;
}

export function requestTimeout(config: LlmConfig): number {
  return config.timeoutMs ?? configuredTimeout(process.env.MINI_AGENT_REQUEST_TIMEOUT_MS);
}

export function createRequestSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  parent?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

// ─── .env loader ─────────────────────────────────────────────────────────────

/**
 * Load KEY=VALUE pairs from a local .env file into process.env (no overwrite).
 * Teaching-friendly: avoids a dotenv dependency.
 */
export function loadDotEnvFile(
  filePath = path.join(process.cwd(), ".env"),
): void {
  if (!existsSync(filePath)) return;

  const text = readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// ─── Config loaders ──────────────────────────────────────────────────────────

export function loadLlmConfigFromEnv(): LlmConfig {
  loadDotEnvFile();

  // ── 1. Active profile (highest precedence) ─────────────────────────────────
  const profileStore = loadProfileStoreSync();
  const activeProfile = profileStore ? getActiveProfile(profileStore) : null;

  if (activeProfile) {
    // Profile fully specifies model, baseUrl, and apiKey.
    const resolved = resolveModel(activeProfile.model, activeProfile.baseUrl);
    const imagePolicy = parseImagePolicy(process.env.IMAGE_POLICY);
    const base: LlmConfig = {
      apiKey: activeProfile.apiKey,
      provider: resolved.provider,
      baseUrl: activeProfile.baseUrl || resolved.baseUrl,
      model: resolved.id,
      capabilities: resolved.capabilities,
      contextWindow: resolved.contextWindow,
      maxTokens: resolved.maxTokens,
      timeoutMs: configuredTimeout(process.env.MINI_AGENT_REQUEST_TIMEOUT_MS),
      piModel: resolved.piModel,
      reasoning: resolved.reasoning,
      imagePolicy,
      toolCallFormat: resolved.toolCallFormat ?? "openai",
    };
    const relayRegistry = loadRelayRegistryFromEnv();
    return applyRelayIfMatched(base, relayRegistry);
  }

  // ── 2. Existing environment-variable / fallback logic ──────────────────────
  const useDeepSeek =
    Boolean(process.env.DEEPSEEK_API_KEY) ||
    /deepseek/i.test(process.env.OPENAI_BASE_URL ?? "") ||
    /deepseek/i.test(process.env.OPENAI_MODEL ?? "");

  const available = getAvailableModels();
  const firstConfigured = available[0];
  const model = process.env.OPENAI_MODEL ||
    (useDeepSeek
      ? "deepseek/deepseek-v4-flash"
      : firstConfigured
        ? `${firstConfigured.provider}/${firstConfigured.id}`
        : "openai/gpt-4o-mini");

  const resolved = resolveModel(model, process.env.OPENAI_BASE_URL);
  const baseUrl = (
    process.env.OPENAI_BASE_URL ||
    resolved.baseUrl ||
    (useDeepSeek ? "https://api.deepseek.com/v1" : "https://api.openai.com/v1")
  ).replace(/\/$/, "");

  const apiKeyNames = [
    ...resolved.apiKeyEnv,
    ...(process.env.OPENAI_BASE_URL ? ["OPENAI_API_KEY"] : []),
  ];
  const apiKey = apiKeyNames
    .map((name) => process.env[name])
    .find((value): value is string => Boolean(value));

  if (!apiKey && !resolved.piModel) {
    throw new Error(
      [
        `Missing API key for model ${resolved.id}.`,
        `Set one of: ${apiKeyNames.join(", ")}.`,
      ].join("\n"),
    );
  }

  const imagePolicy = parseImagePolicy(process.env.IMAGE_POLICY);

  const base: LlmConfig = {
    apiKey: apiKey ?? "",
    provider: resolved.provider,
    baseUrl,
    model: resolved.id,
    capabilities: resolved.capabilities,
    contextWindow: resolved.contextWindow,
    maxTokens: resolved.maxTokens,
    timeoutMs: configuredTimeout(process.env.MINI_AGENT_REQUEST_TIMEOUT_MS),
    piModel: resolved.piModel,
    reasoning: resolved.reasoning,
    imagePolicy,
    toolCallFormat: resolved.toolCallFormat ?? "openai",
  };

  // Apply relay from MINI_AGENT_RELAY env var (overrides baseUrl + adds getApiKey)
  const relayRegistry = loadRelayRegistryFromEnv();
  return applyRelayIfMatched(base, relayRegistry);
}

/** Test helper / explicit config builder. */
export function makeLlmConfig(
  partial: Pick<LlmConfig, "apiKey" | "baseUrl" | "model"> & {
    provider?: string;
    capabilities?: ModelCapabilities;
    contextWindow?: number;
    maxTokens?: number;
    timeoutMs?: number;
    reasoning?: boolean;
    imagePolicy?: ImagePolicy;
  },
): LlmConfig {
  const resolved = resolveModel(partial.model, partial.baseUrl);
  return {
    apiKey: partial.apiKey,
    provider: partial.provider ?? resolved.provider,
    baseUrl: partial.baseUrl.replace(/\/$/, ""),
    model: partial.model,
    capabilities: partial.capabilities ?? resolved.capabilities,
    contextWindow: partial.contextWindow ?? resolved.contextWindow,
    maxTokens: partial.maxTokens ?? resolved.maxTokens,
    timeoutMs: partial.timeoutMs,
    piModel: resolved.piModel,
    reasoning: partial.reasoning ?? resolved.reasoning,
    imagePolicy: partial.imagePolicy ?? "placeholder",
    toolCallFormat: resolved.toolCallFormat ?? "openai",
  };
}

export function switchLlmModel(
  config: LlmConfig,
  model: ModelRef | string,
  overrides: ModelSwitchOverrides = {},
  relayRegistry?: RelayRegistry,
): LlmConfig {
  const requestedBaseUrl = overrides.baseUrl?.trim().replace(/\/$/, "");
  const resolved = typeof model === "string"
    ? resolveModel(model, requestedBaseUrl)
    : requestedBaseUrl
      ? resolveModel(`${model.provider}/${model.id}`, requestedBaseUrl)
      : model;
  const apiKey = resolved.apiKeyEnv
    .map((name) => process.env[name])
    .find((value): value is string => Boolean(value));

  // If no env var key found but the new model targets the same base URL as the
  // current config, reuse the existing API key. This covers the case where
  // DeepSeek (or any provider) is configured via OPENAI_API_KEY + OPENAI_BASE_URL
  // rather than the provider-specific env var name.
  const effectiveApiKey = overrides.apiKey?.trim()
    || apiKey
    || (resolved.baseUrl === config.baseUrl ? config.apiKey : undefined);

  if (!effectiveApiKey && !resolved.piModel) {
    throw new Error(
      `Missing API key for model ${resolved.id}. Set one of: ${resolved.apiKeyEnv.join(", ")}.`,
    );
  }
  const next: LlmConfig = {
    ...config,
    apiKey: effectiveApiKey ?? "",
    // Clear any inherited getApiKey — the new model may need a different resolver
    getApiKey: undefined,
    provider: resolved.provider,
    baseUrl: resolved.baseUrl,
    model: resolved.id,
    capabilities: resolved.capabilities,
    contextWindow: resolved.contextWindow,
    maxTokens: resolved.maxTokens,
    piModel: resolved.piModel,
    reasoning: resolved.reasoning,
    toolCallFormat: resolved.toolCallFormat ?? "openai",
  };

  // Apply relay for the new model if a registry is provided
  if (relayRegistry && relayRegistry.length > 0) {
    return applyRelayIfMatched(next, relayRegistry);
  }
  return next;
}

/**
 * Resolve the effective API key for a request.
 * Calls `getApiKey()` when present, otherwise falls back to the static `apiKey`.
 * This is the single authoritative place all request paths should call.
 */
export async function resolveEffectiveApiKey(config: LlmConfig): Promise<string> {
  if (config.getApiKey) {
    return await config.getApiKey();
  }
  return config.apiKey;
}
