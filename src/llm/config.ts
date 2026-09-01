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
import {
  clampThinkingLevelForModel,
  getDefaultThinkingLevel,
  normalizeThinkingLevelForModel,
} from "../think-intensity.ts";
import type { ModelThinkingLevel } from "../pi-ai/types.ts";
import type { CacheRetention } from "../pi-ai/types.ts";
import type { LlmTimeoutPhase } from "./retry.ts";

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
  firstResponseTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  piModel?: ModelRef["piModel"];
  reasoning: boolean;
  /** Provider compatibility flags used by the fallback OpenAI-compatible path. */
  compat?: Record<string, unknown>;
  /** Provider-neutral thinking level for the current model. Optional for legacy callers. */
  thinkingLevel?: ModelThinkingLevel;
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
  /**
   * Optional session identifier for providers that support session-based caching.
   * Used to enable prompt caching across multiple requests in the same conversation.
   */
  sessionId?: string;
  /**
   * Prompt cache retention preference. Controls how long cached prompts are retained.
   * - `"none"` — disable caching
   * - `"short"` — standard cache (default)
   * - `"long"` — long-term cache where supported
   */
  cacheRetention?: CacheRetention;
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

export const DEFAULT_OUTPUT_TOKEN_CAP = 32_768;
const DEFAULT_OUTPUT_CONTEXT_RATIO = 0.25;

/** Resolve the per-request output limit without changing the model catalog capability. */
export function resolveOutputTokenLimit(
  modelMaxTokens: number,
  contextWindow: number,
  requestedMaxTokens?: number,
): number {
  const safeContextWindow = Number.isFinite(contextWindow)
    ? Math.max(2, Math.floor(contextWindow))
    : 2;
  const safeModelMax = Number.isFinite(modelMaxTokens)
    ? Math.max(1, Math.floor(modelMaxTokens))
    : 1;
  const requested = requestedMaxTokens === undefined
    ? Math.min(DEFAULT_OUTPUT_TOKEN_CAP, Math.max(1, Math.floor(safeContextWindow * DEFAULT_OUTPUT_CONTEXT_RATIO)))
    : Number.isFinite(requestedMaxTokens)
      ? Math.max(1, Math.floor(requestedMaxTokens))
      : 1;
  return Math.min(requested, safeModelMax, safeContextWindow - 1);
}

// ─── Timeout / signal utilities ──────────────────────────────────────────────

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;

function configuredTimeout(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  if (value === 0) return 0;
  return Number.isFinite(value) && value >= 1_000 ? Math.floor(value) : fallback;
}

/**
 * Resolve the total request timeout.
 *
 * Precedence: explicit config override → per-model catalog value →
 * `MINI_AGENT_REQUEST_TIMEOUT_MS` env → built-in default (120s).
 */
export function requestTimeout(config: LlmConfig): number {
  return config.timeoutMs
    ?? config.piModel?.timeoutMs
    ?? configuredTimeout(process.env.MINI_AGENT_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS);
}

/**
 * Resolve the first-response timeout.
 *
 * Precedence: explicit config override → per-model catalog value →
 * `MINI_AGENT_FIRST_RESPONSE_TIMEOUT_MS` env → total request timeout.
 */
export function firstResponseTimeout(config: LlmConfig): number {
  return config.firstResponseTimeoutMs
    ?? config.piModel?.firstResponseTimeoutMs
    ?? configuredTimeout(process.env.MINI_AGENT_FIRST_RESPONSE_TIMEOUT_MS, requestTimeout(config));
}

/**
 * Resolve the stream-idle timeout.
 *
 * Precedence: explicit config override → per-model catalog value →
 * `MINI_AGENT_STREAM_IDLE_TIMEOUT_MS` env → built-in default (60s).
 */
export function streamIdleTimeout(config: LlmConfig): number {
  return config.streamIdleTimeoutMs
    ?? config.piModel?.streamIdleTimeoutMs
    ?? configuredTimeout(process.env.MINI_AGENT_STREAM_IDLE_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS);
}

export function timeoutLimitForPhase(
  config: LlmConfig,
  phase: LlmTimeoutPhase | undefined,
): number {
  if (phase === "first_response") return firstResponseTimeout(config);
  if (phase === "stream_idle") return streamIdleTimeout(config);
  return requestTimeout(config);
}

export type RequestSignalOptions = {
  firstResponseTimeoutMs?: number;
  idleTimeoutMs?: number;
};

export function createRequestSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  timeoutPhase: () => LlmTimeoutPhase | undefined;
  elapsedMs: () => number;
  markResponseStarted: () => void;
  markActivity: () => void;
  cleanup: () => void;
};
export function createRequestSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  options: RequestSignalOptions,
): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  timeoutPhase: () => LlmTimeoutPhase | undefined;
  elapsedMs: () => number;
  markResponseStarted: () => void;
  markActivity: () => void;
  cleanup: () => void;
};
export function createRequestSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  options: RequestSignalOptions = {},
): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  timeoutPhase: () => LlmTimeoutPhase | undefined;
  elapsedMs: () => number;
  markResponseStarted: () => void;
  markActivity: () => void;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const startedAt = Date.now();
  let phase: LlmTimeoutPhase | undefined;
  let firstResponseTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let responseStarted = false;

  const abortFor = (nextPhase: LlmTimeoutPhase) => {
    if (phase) return;
    phase = nextPhase;
    controller.abort();
  };
  const totalTimer = timeoutMs > 0 ? setTimeout(() => abortFor("total"), timeoutMs) : undefined;
  if (options.firstResponseTimeoutMs !== undefined && options.firstResponseTimeoutMs > 0) {
    firstResponseTimer = setTimeout(
      () => abortFor("first_response"),
      options.firstResponseTimeoutMs,
    );
  }
  const refreshIdleTimer = () => {
    if (options.idleTimeoutMs === undefined || options.idleTimeoutMs <= 0 || !responseStarted || phase) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abortFor("stream_idle"), options.idleTimeoutMs);
  };
  const onAbort = () => controller.abort();
  parent?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    didTimeout: () => phase !== undefined,
    timeoutPhase: () => phase,
    elapsedMs: () => Date.now() - startedAt,
    markResponseStarted: () => {
      if (phase || responseStarted) return;
      responseStarted = true;
      if (firstResponseTimer !== undefined) clearTimeout(firstResponseTimer);
      refreshIdleTimer();
    },
    markActivity: refreshIdleTimer,
    cleanup: () => {
      if (totalTimer !== undefined) clearTimeout(totalTimer);
      if (firstResponseTimer !== undefined) clearTimeout(firstResponseTimer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

// ─── .env loader ─────────────────────────────────────────────────────────────

/**
 * Load KEY=VALUE pairs from a local .env file into process.env (no overwrite).
 * Keeps configuration self-contained and avoids an additional dotenv dependency.
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
      maxTokens: resolveOutputTokenLimit(resolved.maxTokens, resolved.contextWindow),
      timeoutMs: activeProfile.timeoutMs ?? resolved.timeoutMs,
      firstResponseTimeoutMs: activeProfile.firstResponseTimeoutMs ?? resolved.firstResponseTimeoutMs,
      streamIdleTimeoutMs: activeProfile.streamIdleTimeoutMs ?? resolved.streamIdleTimeoutMs,
      piModel: resolved.piModel,
      reasoning: resolved.reasoning,
      compat: resolved.compat,
      thinkingLevel: normalizeThinkingLevelForModel(
        resolved.reasoning,
        activeProfile.thinkingLevel ?? getDefaultThinkingLevel(),
      ),
      imagePolicy,
      toolCallFormat: resolved.toolCallFormat ?? "openai",
      sessionId: process.env.MINI_AGENT_SESSION_ID,
      cacheRetention: process.env.MINI_AGENT_CACHE_RETENTION as CacheRetention | undefined,
    };
    const relayRegistry = loadRelayRegistryFromEnv();
    return applyRelayIfMatched({
      ...base,
      thinkingLevel: clampThinkingLevelForModel(base, base.thinkingLevel ?? "off"),
    }, relayRegistry);
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
    maxTokens: resolveOutputTokenLimit(resolved.maxTokens, resolved.contextWindow),
    timeoutMs: resolved.timeoutMs,
    firstResponseTimeoutMs: resolved.firstResponseTimeoutMs,
    streamIdleTimeoutMs: resolved.streamIdleTimeoutMs,
    piModel: resolved.piModel,
    reasoning: resolved.reasoning,
    compat: resolved.compat,
    thinkingLevel: normalizeThinkingLevelForModel(
      resolved.reasoning,
      getDefaultThinkingLevel(),
    ),
    imagePolicy,
    toolCallFormat: resolved.toolCallFormat ?? "openai",
    sessionId: process.env.MINI_AGENT_SESSION_ID,
    cacheRetention: process.env.MINI_AGENT_CACHE_RETENTION as CacheRetention | undefined,
  };

  // Apply relay from MINI_AGENT_RELAY env var (overrides baseUrl + adds getApiKey)
  const relayRegistry = loadRelayRegistryFromEnv();
  return applyRelayIfMatched({
    ...base,
    thinkingLevel: clampThinkingLevelForModel(base, base.thinkingLevel ?? "off"),
  }, relayRegistry);
}

/** Test helper / explicit config builder. */
export function makeLlmConfig(
  partial: Pick<LlmConfig, "apiKey" | "baseUrl" | "model"> & {
    provider?: string;
    capabilities?: ModelCapabilities;
    contextWindow?: number;
    maxTokens?: number;
    timeoutMs?: number;
    firstResponseTimeoutMs?: number;
    streamIdleTimeoutMs?: number;
    reasoning?: boolean;
    thinkingLevel?: ModelThinkingLevel;
    imagePolicy?: ImagePolicy;
    sessionId?: string;
    cacheRetention?: CacheRetention;
    compat?: Record<string, unknown>;
  },
): LlmConfig {
  const resolved = resolveModel(partial.model, partial.baseUrl);
  const base: LlmConfig = {
    apiKey: partial.apiKey,
    provider: partial.provider ?? resolved.provider,
    baseUrl: partial.baseUrl.replace(/\/$/, ""),
    model: partial.model,
    capabilities: partial.capabilities ?? resolved.capabilities,
    contextWindow: partial.contextWindow ?? resolved.contextWindow,
    maxTokens: resolveOutputTokenLimit(
      resolved.maxTokens,
      partial.contextWindow ?? resolved.contextWindow,
      partial.maxTokens,
    ),
    timeoutMs: partial.timeoutMs ?? resolved.timeoutMs,
    firstResponseTimeoutMs: partial.firstResponseTimeoutMs ?? resolved.firstResponseTimeoutMs,
    streamIdleTimeoutMs: partial.streamIdleTimeoutMs ?? resolved.streamIdleTimeoutMs,
    piModel: resolved.piModel,
    reasoning: partial.reasoning ?? resolved.reasoning,
    compat: partial.compat ?? resolved.compat,
    thinkingLevel: normalizeThinkingLevelForModel(
      partial.reasoning ?? resolved.reasoning,
      partial.thinkingLevel ?? getDefaultThinkingLevel(),
    ),
    imagePolicy: partial.imagePolicy ?? "placeholder",
    toolCallFormat: resolved.toolCallFormat ?? "openai",
    sessionId: partial.sessionId,
    cacheRetention: partial.cacheRetention,
  };
  return {
    ...base,
    thinkingLevel: clampThinkingLevelForModel(base, base.thinkingLevel ?? "off"),
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
  // Adopt the target model's catalog timeout overrides. Explicitly clear any
  // inherited values so switching away from a slow-thinking model back to a
  // normal one does not keep its longer deadlines.
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
    maxTokens: resolveOutputTokenLimit(resolved.maxTokens, resolved.contextWindow),
    piModel: resolved.piModel,
    reasoning: resolved.reasoning,
    compat: resolved.compat,
    thinkingLevel: normalizeThinkingLevelForModel(
      resolved.reasoning,
      config.reasoning
        ? config.thinkingLevel ?? getDefaultThinkingLevel()
        : getDefaultThinkingLevel(),
    ),
    toolCallFormat: resolved.toolCallFormat ?? "openai",
    // Inherit sessionId and cacheRetention from current config or env
    sessionId: config.sessionId ?? process.env.MINI_AGENT_SESSION_ID,
    cacheRetention: config.cacheRetention ?? (process.env.MINI_AGENT_CACHE_RETENTION as CacheRetention | undefined),
    timeoutMs: resolved.timeoutMs,
    firstResponseTimeoutMs: resolved.firstResponseTimeoutMs,
    streamIdleTimeoutMs: resolved.streamIdleTimeoutMs,
  };

  // Apply relay for the new model if a registry is provided
  const clampedNext = {
    ...next,
    thinkingLevel: clampThinkingLevelForModel(next, next.thinkingLevel ?? "off"),
  };
  if (relayRegistry && relayRegistry.length > 0) {
    return applyRelayIfMatched(clampedNext, relayRegistry);
  }
  return clampedNext;
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
