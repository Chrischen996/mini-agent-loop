/**
 * Relay / API-Gateway support.
 *
 * A "relay" is an HTTP proxy that sits between mini-agent and an upstream LLM
 * provider (OpenAI, Anthropic, …).  It has its own base URL and its own API
 * key, which can differ from the provider's native key.
 *
 * Configuration is driven by the MINI_AGENT_RELAY environment variable (JSON)
 * so that no code changes are required to add or change relay settings.
 *
 * @example Single relay for all requests
 * ```
 * MINI_AGENT_RELAY='{"baseUrl":"https://relay.example.com/v1","apiKey":"relay-sk-xxx"}'
 * ```
 *
 * @example Per-provider relays with key pools
 * ```
 * MINI_AGENT_RELAY='[
 *   {"providers":["openai"],"baseUrl":"https://openai-relay.example.com/v1","apiKey":["k1","k2"]},
 *   {"providers":["anthropic"],"baseUrl":"https://anthropic-relay.example.com/v1","apiKey":"anth-key"},
 *   {"providers":["*"],"baseUrl":"https://fallback-relay.example.com/v1","apiKey":"fallback-key"}
 * ]'
 * ```
 */

import type { LlmConfig } from "./llm.ts";

// ─── types ───────────────────────────────────────────────────────────────────

/**
 * Configuration for a single relay endpoint.
 *
 * `providers` and `models` act as allowlists.  Omitting a field means "match
 * everything".  Use `"*"` as a catch-all inside the array.
 *
 * Entries in a {@link RelayRegistry} are tested in declaration order; the
 * first match wins.
 */
export type RelayEntry = {
  /**
   * Provider names to match (e.g. `["openai", "anthropic"]`).
   * Omit or use `["*"]` to match all providers.
   */
  providers?: string[];
  /**
   * Model ids to match (e.g. `["gpt-4o", "gpt-4o-mini"]`).
   * Omit or use `["*"]` to match all models.
   */
  models?: string[];
  /** Base URL of the relay endpoint (trailing slash is stripped automatically). */
  baseUrl: string;
  /**
   * API key for the relay endpoint.  Three forms are accepted:
   * - `string` — a single static key
   * - `string[]` — a pool of keys that are rotated round-robin per request
   * - `() => string | Promise<string>` — a factory for dynamic / expiring keys
   */
  apiKey: string | string[] | (() => string | Promise<string>);
};

/** An ordered list of relay entries.  First match wins. */
export type RelayRegistry = RelayEntry[];

// ─── matching ────────────────────────────────────────────────────────────────

/**
 * Find the first {@link RelayEntry} that matches `provider` and `modelId`.
 * Returns `undefined` when no entry matches.
 */
export function matchRelay(
  registry: RelayRegistry,
  provider: string,
  modelId: string,
): RelayEntry | undefined {
  const normalizedProvider = provider.toLowerCase();
  const normalizedModel = modelId.toLowerCase();

  return registry.find((entry) => {
    const providerMatch =
      !entry.providers ||
      entry.providers.some(
        (p) => p === "*" || p.toLowerCase() === normalizedProvider,
      );
    const modelMatch =
      !entry.models ||
      entry.models.some(
        (m) => m === "*" || m.toLowerCase() === normalizedModel,
      );
    return providerMatch && modelMatch;
  });
}

// ─── key resolver ─────────────────────────────────────────────────────────────

/**
 * Build a `getApiKey` function from the `apiKey` field of a {@link RelayEntry}.
 *
 * - Single string → always returns that string
 * - String array  → rotates through the pool round-robin (counter is per-resolver instance)
 * - Function      → called as-is (may return a Promise for async token refresh)
 */
export function createKeyResolver(
  apiKey: RelayEntry["apiKey"],
): () => string | Promise<string> {
  if (typeof apiKey === "function") {
    return apiKey;
  }
  if (typeof apiKey === "string") {
    return () => apiKey;
  }
  // key pool — round-robin
  if (apiKey.length === 0) {
    throw new Error("Relay apiKey array must not be empty");
  }
  let index = 0;
  return () => {
    const key = apiKey[index % apiKey.length]!;
    index += 1;
    return key;
  };
}

// ─── apply ───────────────────────────────────────────────────────────────────

/**
 * Return a new {@link LlmConfig} with `baseUrl` and `getApiKey` replaced by
 * the values from `relay`.  All other fields are preserved.
 */
export function applyRelay(config: LlmConfig, relay: RelayEntry): LlmConfig {
  return {
    ...config,
    baseUrl: relay.baseUrl.replace(/\/$/, ""),
    getApiKey: createKeyResolver(relay.apiKey),
  };
}

// ─── parsing ─────────────────────────────────────────────────────────────────

function isRelayEntry(value: unknown): value is RelayEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.baseUrl !== "string" || !entry.baseUrl.trim()) return false;
  const { apiKey } = entry;
  if (
    typeof apiKey !== "string" &&
    !Array.isArray(apiKey) &&
    typeof apiKey !== "function"
  )
    return false;
  if (Array.isArray(apiKey) && !apiKey.every((k) => typeof k === "string"))
    return false;
  if (entry.providers !== undefined && !Array.isArray(entry.providers))
    return false;
  if (entry.models !== undefined && !Array.isArray(entry.models)) return false;
  return true;
}

/**
 * Parse the value of the `MINI_AGENT_RELAY` environment variable into a
 * {@link RelayRegistry}.  Accepts either a single entry object or a JSON
 * array of entries.  Returns an empty array for invalid / absent input so the
 * caller can always iterate safely.
 */
export function parseRelayRegistry(raw: string | undefined): RelayRegistry {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  // Accept a bare object (single relay) or an array
  const candidates: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const registry: RelayRegistry = [];
  for (const candidate of candidates) {
    if (isRelayEntry(candidate)) {
      registry.push(candidate as RelayEntry);
    }
  }
  return registry;
}

// ─── convenience ──────────────────────────────────────────────────────────────

/**
 * Load the relay registry from the `MINI_AGENT_RELAY` environment variable.
 * Returns an empty array when the variable is absent or malformed.
 */
export function loadRelayRegistryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RelayRegistry {
  return parseRelayRegistry(env.MINI_AGENT_RELAY);
}

/**
 * Apply the first matching relay from `registry` to `config`, or return
 * `config` unchanged when no entry matches.
 */
export function applyRelayIfMatched(
  config: LlmConfig,
  registry: RelayRegistry,
): LlmConfig {
  if (registry.length === 0) return config;
  const relay = matchRelay(registry, config.provider, config.model);
  return relay ? applyRelay(config, relay) : config;
}
