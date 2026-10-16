/**
 * Persisted Model Profiles
 *
 * Manages a versioned JSON store at ~/.mini-agent/models.json
 * (overridable with MINI_AGENT_MODEL_CONFIG env var).
 *
 * Schema (version 1):
 * {
 *   "version": 1,
 *   "activeProfile": "my-profile",
 *   "profiles": {
 *     "my-profile": {
 *       "model": "openai/gpt-4o-mini",
 *       "baseUrl": "https://api.openai.com/v1",
 *       "apiKey": "sk-...",
 *       "thinkingLevel": "medium",
 *       "timeoutMs": 300000,
 *       "firstResponseTimeoutMs": 300000,
 *       "streamIdleTimeoutMs": 90000
 *     }
 *   }
 * }
 *
 * API keys are stored in plaintext; the file is created with 0600 permissions.
 * Do NOT expose apiKey through API responses or logs.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { OpenAICompletionsCompat, ModelThinkingLevel } from "./pi-ai/types.ts";
import { ALL_THINKING_LEVELS, THINKING_EFFORT_LEVELS } from "./pi-ai/thinking-levels.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ModelProfile = {
  model: string;
  baseUrl: string;
  apiKey: string;
  /** Optional for backwards compatibility with existing profiles. */
  thinkingLevel?: ModelThinkingLevel;
  /** Optional per-model total request timeout (ms). */
  timeoutMs?: number;
  /** Optional per-model time-to-first-chunk timeout (ms). */
  firstResponseTimeoutMs?: number;
  /** Optional per-model stream-idle timeout (ms). */
  streamIdleTimeoutMs?: number;
};

export type CustomProviderProtocol = "openai-completions" | "openai-responses" | "anthropic-messages";

export type ReasoningEfforts = false | Partial<Record<ModelThinkingLevel, string | null>>;
export type CustomThinkingCompat = Pick<OpenAICompletionsCompat, "thinkingFormat" | "supportsReasoningEffort">;

export type CustomProviderModel = {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<"text" | "image">;
  tools?: boolean;
  reasoning?: boolean;
  reasoningEfforts?: ReasoningEfforts;
  defaultThinkingLevel?: ModelThinkingLevel;
  compat?: CustomThinkingCompat;
};

/** A user-defined gateway persisted with the profile store. */
export type CustomProviderProfile = {
  displayName?: string;
  baseUrl: string;
  protocol: CustomProviderProtocol;
  apiKey: string;
  compat?: CustomThinkingCompat;
  models: CustomProviderModel[];
};

export type ModelProfileStore = {
  version: 1;
  activeProfile: string | null;
  profiles: Record<string, ModelProfile>;
  /**
   * Maps subagent role names to a profile name in `profiles`.
   * When set, the named profile's model/baseUrl/apiKey is used for that role.
   *
   * Built-in roles: "researcher", "coder", "reviewer"
   * Custom roles: any string matching a subagent profile name
   *
   * @example { researcher: "agnes-ai-agnes-2-0-flash", coder: "anthropic-claude-opus-4-6" }
   */
  subagentRoles?: Record<string, string>;
  /** Custom gateways configured from the Web settings page. */
  customProviders?: Record<string, CustomProviderProfile>;
};

// ─── Defaults & Path Resolution ───────────────────────────────────────────────

export function resolveProfileStorePath(): string {
  return (
    process.env.MINI_AGENT_MODEL_CONFIG ||
    path.join(os.homedir(), ".mini-agent", "models.json")
  );
}

function emptyStore(): ModelProfileStore {
  return { version: 1, activeProfile: null, profiles: {} };
}

// ─── Schema Validation ────────────────────────────────────────────────────────

export class ProfileStoreValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileStoreValidationError";
  }
}

function validateProfile(name: string, raw: unknown): ModelProfile {
  if (!raw || typeof raw !== "object") {
    throw new ProfileStoreValidationError(`Profile "${name}" is not an object`);
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.model !== "string" || !p.model.trim()) {
    throw new ProfileStoreValidationError(`Profile "${name}".model must be a non-empty string`);
  }
  if (typeof p.baseUrl !== "string" || !p.baseUrl.trim()) {
    throw new ProfileStoreValidationError(`Profile "${name}".baseUrl must be a non-empty string`);
  }
  if (typeof p.apiKey !== "string") {
    throw new ProfileStoreValidationError(`Profile "${name}".apiKey must be a string`);
  }
  const validThinkingLevels = new Set(ALL_THINKING_LEVELS);
  if (p.thinkingLevel !== undefined && !validThinkingLevels.has(p.thinkingLevel as ModelThinkingLevel)) {
    throw new ProfileStoreValidationError(
      `Profile "${name}".thinkingLevel must be one of ${THINKING_EFFORT_LEVELS.join(",")}, or off`,
    );
  }
  const validTimeout = (field: string): number | undefined => {
    if (p[field] === undefined) return undefined;
    if (typeof p[field] !== "number" || !Number.isFinite(p[field]) || p[field] < 1000) {
      throw new ProfileStoreValidationError(
        `Profile "${name}".${field} must be a number of milliseconds >= 1000`,
      );
    }
    return Math.floor(p[field] as number);
  };
  const timeoutMs = validTimeout("timeoutMs");
  const firstResponseTimeoutMs = validTimeout("firstResponseTimeoutMs");
  const streamIdleTimeoutMs = validTimeout("streamIdleTimeoutMs");
  return {
    model: p.model.trim(),
    baseUrl: normalizeUrl(p.baseUrl),
    apiKey: p.apiKey,
    ...(p.thinkingLevel !== undefined
      ? { thinkingLevel: p.thinkingLevel as ModelThinkingLevel }
      : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(firstResponseTimeoutMs !== undefined ? { firstResponseTimeoutMs } : {}),
    ...(streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs } : {}),
  };
}

const CUSTOM_PROVIDER_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function positiveInteger(value: unknown, fallback: number, maximum = 2_000_000_000): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), maximum);
}

function validateThinkingCompat(raw: unknown, protocol: unknown): CustomThinkingCompat | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ProfileStoreValidationError("compat must be an object");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length && protocol !== "openai-completions") throw new ProfileStoreValidationError("Thinking compat fields require openai-completions");
  const formats = ["openai", "deepseek", "openrouter", "qwen", "qwen-chat-template", "zai", "together", "string-thinking", "ant-ling"];
  for (const key of Object.keys(value)) if (key !== "thinkingFormat" && key !== "supportsReasoningEffort") throw new ProfileStoreValidationError(`Unsupported compat field: ${key}`);
  if (value.thinkingFormat !== undefined && !formats.includes(String(value.thinkingFormat))) throw new ProfileStoreValidationError("Unsupported thinkingFormat");
  if (value.supportsReasoningEffort !== undefined && typeof value.supportsReasoningEffort !== "boolean") throw new ProfileStoreValidationError("supportsReasoningEffort must be boolean");
  return { ...value } as CustomThinkingCompat;
}

function validateReasoningEfforts(raw: unknown): ReasoningEfforts | undefined {
  if (raw === undefined || raw === false) return raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ProfileStoreValidationError("reasoningEfforts must be false or a non-empty object");
  const result: Exclude<ReasoningEfforts, false> = {};
  for (const [level, wire] of Object.entries(raw)) {
    if (!ALL_THINKING_LEVELS.includes(level as ModelThinkingLevel)) throw new ProfileStoreValidationError(`Invalid thinking level: ${level}`);
    if (wire !== null && (typeof wire !== "string" || !wire.trim())) throw new ProfileStoreValidationError(`reasoningEfforts.${level} must be a non-empty string`);
    if (wire === null && level !== "off") throw new ProfileStoreValidationError(`Only reasoningEfforts.off may be null`);
    result[level as ModelThinkingLevel] = typeof wire === "string" ? wire.trim() : null;
  }
  if (!Object.keys(result).some((level) => level !== "off")) throw new ProfileStoreValidationError("reasoningEfforts must offer a thinking level");
  return result;
}

function validateCustomProviderModel(provider: string, raw: unknown, protocol: unknown): CustomProviderModel {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProfileStoreValidationError(`Custom provider "${provider}" model must be an object`);
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !value.id.trim()) {
    throw new ProfileStoreValidationError(`Custom provider "${provider}" model.id must be a non-empty string`);
  }
  const reasoningEfforts = validateReasoningEfforts(value.reasoningEfforts);
  const reasoning = reasoningEfforts === undefined ? value.reasoning === true : reasoningEfforts !== false;
  const compat = validateThinkingCompat(value.compat, protocol);
  const defaultThinkingLevel = value.defaultThinkingLevel as ModelThinkingLevel | undefined;
  if (defaultThinkingLevel !== undefined && (!ALL_THINKING_LEVELS.includes(defaultThinkingLevel) ||
    (!reasoning && defaultThinkingLevel !== "off") ||
    (reasoningEfforts && !Object.hasOwn(reasoningEfforts, defaultThinkingLevel)) ||
    (reasoning && reasoningEfforts === undefined && ["xhigh", "max", "ultra"].includes(defaultThinkingLevel)))) {
    throw new ProfileStoreValidationError("defaultThinkingLevel must be supported by the model");
  }
  const id = value.id.trim();
  const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : undefined;
  const contextWindow = positiveInteger(value.contextWindow, 128_000);
  const maxTokens = Math.min(positiveInteger(value.maxTokens, 16_384), Math.max(1, contextWindow - 1));
  const input = Array.isArray(value.input)
    ? value.input.filter((item): item is "text" | "image" => item === "text" || item === "image")
    : ["text" as const];
  const uniqueInput = [...new Set(input.length > 0 ? input : ["text" as const])];
  return {
    id,
    ...(name ? { name } : {}),
    contextWindow,
    maxTokens,
    input: uniqueInput,
    tools: value.tools !== false,
    reasoning,
    ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
    ...(defaultThinkingLevel !== undefined ? { defaultThinkingLevel } : {}),
    ...(compat ? { compat } : {}),
  };
}

export function validateCustomProvider(
  providerName: string,
  raw: unknown,
): CustomProviderProfile {
  const provider = providerName.trim().toLowerCase();
  if (!CUSTOM_PROVIDER_ID.test(provider)) {
    throw new ProfileStoreValidationError(
      `Custom provider id must match ${CUSTOM_PROVIDER_ID.source}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProfileStoreValidationError(`Custom provider "${provider}" must be an object`);
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.baseUrl !== "string" || !value.baseUrl.trim()) {
    throw new ProfileStoreValidationError(`Custom provider "${provider}".baseUrl must be a non-empty string`);
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value.baseUrl.trim());
  } catch {
    throw new ProfileStoreValidationError(`Custom provider "${provider}".baseUrl must be a valid http(s) URL`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new ProfileStoreValidationError(`Custom provider "${provider}".baseUrl must use http or https`);
  }
  if (typeof value.apiKey !== "string" || !value.apiKey.trim()) {
    throw new ProfileStoreValidationError(`Custom provider "${provider}".apiKey must be a non-empty string`);
  }
  if (value.protocol !== "openai-completions" && value.protocol !== "openai-responses" && value.protocol !== "anthropic-messages") {
    throw new ProfileStoreValidationError(
      `Custom provider "${provider}".protocol must be openai-completions, openai-responses, or anthropic-messages`,
    );
  }
  if (!Array.isArray(value.models) || value.models.length === 0) {
    throw new ProfileStoreValidationError(`Custom provider "${provider}".models must contain at least one model`);
  }
  const models = value.models.map((model) => validateCustomProviderModel(provider, model, value.protocol));
  const ids = new Set<string>();
  for (const model of models) {
    const key = model.id.toLowerCase();
    if (ids.has(key)) {
      throw new ProfileStoreValidationError(`Custom provider "${provider}" contains duplicate model "${model.id}"`);
    }
    ids.add(key);
  }
  const displayName = typeof value.displayName === "string" && value.displayName.trim()
    ? value.displayName.trim()
    : undefined;
  return {
    ...(displayName ? { displayName } : {}),
    baseUrl: normalizeUrl(parsedUrl.toString()),
    protocol: value.protocol,
    ...(value.compat !== undefined ? { compat: validateThinkingCompat(value.compat, value.protocol) } : {}),
    apiKey: value.apiKey,
    models,
  };
}

function validateStore(raw: unknown): ModelProfileStore {
  if (!raw || typeof raw !== "object") {
    throw new ProfileStoreValidationError("Store root must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new ProfileStoreValidationError(
      `Unsupported store version: ${String(obj.version)}. Expected 1.`
    );
  }
  if (obj.activeProfile !== null && typeof obj.activeProfile !== "string") {
    throw new ProfileStoreValidationError("activeProfile must be a string or null");
  }
  if (!obj.profiles || typeof obj.profiles !== "object" || Array.isArray(obj.profiles)) {
    throw new ProfileStoreValidationError("profiles must be an object");
  }
  const profiles: Record<string, ModelProfile> = {};
  for (const [name, value] of Object.entries(obj.profiles as Record<string, unknown>)) {
    profiles[name] = validateProfile(name, value);
  }

  // Validate subagentRoles if present
  let subagentRoles: Record<string, string> | undefined;
  if (obj.subagentRoles !== undefined) {
    if (typeof obj.subagentRoles !== "object" || Array.isArray(obj.subagentRoles)) {
      throw new ProfileStoreValidationError("subagentRoles must be an object");
    }
    subagentRoles = {};
    for (const [role, profileName] of Object.entries(obj.subagentRoles as Record<string, unknown>)) {
      if (typeof profileName !== "string") {
        throw new ProfileStoreValidationError(`subagentRoles["${role}"] must be a string`);
      }
      subagentRoles[role] = profileName;
    }
  }

  let customProviders: Record<string, CustomProviderProfile> | undefined;
  if (obj.customProviders !== undefined) {
    if (typeof obj.customProviders !== "object" || Array.isArray(obj.customProviders)) {
      throw new ProfileStoreValidationError("customProviders must be an object");
    }
    customProviders = {};
    for (const [provider, value] of Object.entries(obj.customProviders as Record<string, unknown>)) {
      customProviders[provider] = validateCustomProvider(provider, value);
    }
  }

  return {
    version: 1,
    activeProfile: typeof obj.activeProfile === "string" ? obj.activeProfile : null,
    profiles,
    ...(subagentRoles ? { subagentRoles } : {}),
    ...(customProviders ? { customProviders } : {}),
  };
}

// ─── URL Normalization ────────────────────────────────────────────────────────

export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/$/, "");
}

// ─── Load ─────────────────────────────────────────────────────────────────────

/**
 * Load the profile store from disk. Returns an empty store if the file does
 * not exist. Throws `ProfileStoreValidationError` for malformed JSON or schema.
 */
export async function loadProfileStore(
  storePath = resolveProfileStorePath()
): Promise<ModelProfileStore> {
  if (!existsSync(storePath)) {
    return emptyStore();
  }
  let text: string;
  try {
    text = await readFile(storePath, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to read profile store at ${storePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProfileStoreValidationError(
      `Profile store at ${storePath} contains malformed JSON`
    );
  }
  return validateStore(parsed);
}

/**
 * Synchronous variant used during startup in `loadLlmConfigFromEnv`.
 * Returns `null` when the file is missing or unreadable without throwing.
 */
export function loadProfileStoreSync(
  storePath = resolveProfileStorePath()
): ModelProfileStore | null {
  if (!existsSync(storePath)) return null;
  try {
    const text = readFileSync(storePath, "utf8");
    const parsed: unknown = JSON.parse(text);
    return validateStore(parsed);
  } catch {
    return null;
  }
}

// ─── Save (Atomic) ────────────────────────────────────────────────────────────

/**
 * Atomically write the store: write to a temp file, chmod 0600, then rename.
 * Creates the directory if it does not exist.
 */
export async function saveProfileStore(
  store: ModelProfileStore,
  storePath = resolveProfileStorePath()
): Promise<void> {
  const dir = path.dirname(storePath);
  await mkdir(dir, { recursive: true });

  const content = JSON.stringify(store, null, 2) + "\n";
  const tmpPath = `${storePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, content, { encoding: "utf8" });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, storePath);
  } catch (err) {
    // Best-effort cleanup
    try { await import("node:fs/promises").then((m) => m.unlink(tmpPath)); } catch { /* ignore */ }
    throw new Error(
      `Failed to save profile store to ${storePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ─── Profile Operations ───────────────────────────────────────────────────────

/**
 * Return the active profile, or null if none is configured.
 */
export function getActiveProfile(store: ModelProfileStore): ModelProfile | null {
  if (!store.activeProfile) return null;
  return store.profiles[store.activeProfile] ?? null;
}

/**
 * Upsert a profile and optionally make it active. Returns the updated store
 * (does not persist to disk; call `saveProfileStore` separately).
 */
export function upsertProfile(
  store: ModelProfileStore,
  name: string,
  profile: ModelProfile,
  makeActive = true
): ModelProfileStore {
  if (!name.trim()) throw new Error("Profile name must not be empty");
  const validated = validateProfile(name, profile);
  return {
    ...store,
    activeProfile: makeActive ? name : store.activeProfile,
    profiles: { ...store.profiles, [name]: validated },
  };
}

/**
 * Switch the active profile without modifying profile data.
 * Throws if the profile does not exist.
 */
export function switchActiveProfile(
  store: ModelProfileStore,
  name: string
): ModelProfileStore {
  if (!(name in store.profiles)) {
    throw new Error(`Profile "${name}" does not exist`);
  }
  return { ...store, activeProfile: name };
}

/**
 * Delete a profile. If the deleted profile was active, `activeProfile` is set
 * to the first remaining profile name, or null if none remain.
 */
export function deleteProfile(store: ModelProfileStore, name: string): ModelProfileStore {
  if (!(name in store.profiles)) {
    throw new Error(`Profile "${name}" does not exist`);
  }
  const { [name]: _removed, ...remaining } = store.profiles;
  const firstRemaining = Object.keys(remaining)[0] ?? null;
  return {
    ...store,
    activeProfile: store.activeProfile === name ? firstRemaining : store.activeProfile,
    profiles: remaining,
  };
}

/**
 * List all profile names with a marker for the active one.
 */
export function listProfiles(
  store: ModelProfileStore
): Array<{ name: string; active: boolean; model: string; baseUrl: string }> {
  return Object.entries(store.profiles).map(([name, profile]) => ({
    name,
    active: name === store.activeProfile,
    model: profile.model,
    baseUrl: profile.baseUrl,
  }));
}

export function upsertCustomProvider(
  store: ModelProfileStore,
  provider: string,
  profile: CustomProviderProfile,
): ModelProfileStore {
  const normalizedProvider = provider.trim().toLowerCase();
  const validated = validateCustomProvider(normalizedProvider, profile);
  return {
    ...store,
    customProviders: {
      ...(store.customProviders ?? {}),
      [normalizedProvider]: validated,
    },
  };
}

export function deleteCustomProvider(store: ModelProfileStore, provider: string): ModelProfileStore {
  const normalizedProvider = provider.trim().toLowerCase();
  if (!(normalizedProvider in (store.customProviders ?? {}))) {
    throw new Error(`Custom provider "${normalizedProvider}" does not exist`);
  }
  const { [normalizedProvider]: _removed, ...remaining } = store.customProviders ?? {};
  return {
    ...store,
    ...(Object.keys(remaining).length > 0 ? { customProviders: remaining } : { customProviders: undefined }),
  };
}

// ─── Convenience: load + operate + save ──────────────────────────────────────

/** Load, upsert a profile, and persist. Returns the updated store. */
export async function saveProfile(
  name: string,
  profile: ModelProfile,
  makeActive = true,
  storePath = resolveProfileStorePath()
): Promise<ModelProfileStore> {
  const store = await loadProfileStore(storePath);
  const updated = upsertProfile(store, name, profile, makeActive);
  await saveProfileStore(updated, storePath);
  return updated;
}

/** Load, switch active profile, and persist. Returns the updated store. */
export async function activateProfile(
  name: string,
  storePath = resolveProfileStorePath()
): Promise<ModelProfileStore> {
  const store = await loadProfileStore(storePath);
  const updated = switchActiveProfile(store, name);
  await saveProfileStore(updated, storePath);
  return updated;
}

/** Load, delete a profile, and persist. Returns the updated store. */
export async function removeProfile(
  name: string,
  storePath = resolveProfileStorePath()
): Promise<ModelProfileStore> {
  const store = await loadProfileStore(storePath);
  const updated = deleteProfile(store, name);
  await saveProfileStore(updated, storePath);
  return updated;
}

/** Load, upsert a custom provider, and persist it. */
export async function saveCustomProvider(
  provider: string,
  profile: CustomProviderProfile,
  storePath = resolveProfileStorePath(),
): Promise<ModelProfileStore> {
  const store = await loadProfileStore(storePath);
  const updated = upsertCustomProvider(store, provider, profile);
  await saveProfileStore(updated, storePath);
  return updated;
}

/** Load, delete a custom provider, and persist it. */
export async function removeCustomProvider(
  provider: string,
  storePath = resolveProfileStorePath(),
): Promise<ModelProfileStore> {
  const store = await loadProfileStore(storePath);
  const updated = deleteCustomProvider(store, provider);
  await saveProfileStore(updated, storePath);
  return updated;
}

// ─── Subagent Role Bindings ───────────────────────────────────────────────────

/**
 * Bind a subagent role to an existing profile.
 * role: "researcher" | "coder" | "reviewer" | any custom name
 * profileName: must exist in store.profiles (pass null to clear)
 */
export function setSubagentRole(
  store: ModelProfileStore,
  role: string,
  profileName: string | null,
): ModelProfileStore {
  const current = store.subagentRoles ?? {};
  if (profileName === null) {
    const { [role]: _removed, ...rest } = current;
    return { ...store, subagentRoles: Object.keys(rest).length > 0 ? rest : undefined };
  }
  if (!(profileName in store.profiles)) {
    throw new Error(`Profile "${profileName}" does not exist`);
  }
  return { ...store, subagentRoles: { ...current, [role]: profileName } };
}

/**
 * Resolve subagent role configs from a store.
 * Returns a map of role → { model, baseUrl, apiKey } for all bound roles.
 */
export function resolveSubagentRoleLlmConfigs(
  store: ModelProfileStore,
): Record<string, ModelProfile> {
  const result: Record<string, ModelProfile> = {};
  if (!store.subagentRoles) return result;
  for (const [role, profileName] of Object.entries(store.subagentRoles)) {
    const profile = store.profiles[profileName];
    if (profile) result[role] = profile;
  }
  return result;
}

/** Load, set a subagent role binding, and persist. Returns the updated store. */
export async function saveSubagentRole(
  role: string,
  profileName: string | null,
  storePath = resolveProfileStorePath(),
): Promise<ModelProfileStore> {
  const store = await loadProfileStore(storePath);
  const updated = setSubagentRole(store, role, profileName);
  await saveProfileStore(updated, storePath);
  return updated;
}
