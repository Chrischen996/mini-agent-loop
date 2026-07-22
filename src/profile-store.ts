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
 *       "apiKey": "sk-..."
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

// ─── Types ────────────────────────────────────────────────────────────────────

export type ModelProfile = {
  model: string;
  baseUrl: string;
  apiKey: string;
};

export type ModelProfileStore = {
  version: 1;
  activeProfile: string | null;
  profiles: Record<string, ModelProfile>;
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
  return {
    model: p.model.trim(),
    baseUrl: normalizeUrl(p.baseUrl),
    apiKey: p.apiKey,
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
  return {
    version: 1,
    activeProfile: typeof obj.activeProfile === "string" ? obj.activeProfile : null,
    profiles,
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
