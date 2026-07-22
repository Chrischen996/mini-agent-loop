import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  activateProfile,
  deleteProfile,
  getActiveProfile,
  listProfiles,
  loadProfileStore,
  normalizeUrl,
  ProfileStoreValidationError,
  removeProfile,
  resolveProfileStorePath,
  saveProfile,
  saveProfileStore,
  switchActiveProfile,
  upsertProfile,
  type ModelProfile,
  type ModelProfileStore,
} from "../src/profile-store.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tmpStorePath(): string {
  return path.join(tmpdir(), `mini-agent-test-${randomUUID()}`, "models.json");
}

function makeStore(overrides: Partial<ModelProfileStore> = {}): ModelProfileStore {
  return {
    version: 1,
    activeProfile: null,
    profiles: {},
    ...overrides,
  };
}

const SAMPLE_PROFILE: ModelProfile = {
  model: "openai/gpt-4o-mini",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-test",
};

// ─── normalizeUrl ─────────────────────────────────────────────────────────────

describe("normalizeUrl", () => {
  it("strips trailing slash", () => {
    assert.equal(normalizeUrl("https://api.example.com/v1/"), "https://api.example.com/v1");
  });

  it("leaves URL without trailing slash unchanged", () => {
    assert.equal(normalizeUrl("https://api.example.com/v1"), "https://api.example.com/v1");
  });

  it("trims whitespace", () => {
    assert.equal(normalizeUrl("  https://api.example.com/v1  "), "https://api.example.com/v1");
  });
});

// ─── resolveProfileStorePath ──────────────────────────────────────────────────

describe("resolveProfileStorePath", () => {
  it("returns MINI_AGENT_MODEL_CONFIG when set", () => {
    const original = process.env.MINI_AGENT_MODEL_CONFIG;
    process.env.MINI_AGENT_MODEL_CONFIG = "/custom/path/models.json";
    try {
      assert.equal(resolveProfileStorePath(), "/custom/path/models.json");
    } finally {
      if (original === undefined) delete process.env.MINI_AGENT_MODEL_CONFIG;
      else process.env.MINI_AGENT_MODEL_CONFIG = original;
    }
  });

  it("defaults to ~/.mini-agent/models.json", () => {
    const original = process.env.MINI_AGENT_MODEL_CONFIG;
    delete process.env.MINI_AGENT_MODEL_CONFIG;
    try {
      const p = resolveProfileStorePath();
      assert.ok(p.includes(".mini-agent"));
      assert.ok(p.endsWith("models.json"));
    } finally {
      if (original !== undefined) process.env.MINI_AGENT_MODEL_CONFIG = original;
    }
  });
});

// ─── loadProfileStore (missing file) ─────────────────────────────────────────

describe("loadProfileStore — missing file fallback", () => {
  it("returns an empty store when the file does not exist", async () => {
    const storePath = tmpStorePath();
    const store = await loadProfileStore(storePath);
    assert.equal(store.version, 1);
    assert.equal(store.activeProfile, null);
    assert.deepEqual(store.profiles, {});
  });
});

// ─── saveProfileStore + loadProfileStore ──────────────────────────────────────

describe("saveProfileStore + loadProfileStore — round-trip", () => {
  let storePath: string;

  before(async () => {
    storePath = tmpStorePath();
    await mkdir(path.dirname(storePath), { recursive: true });
  });

  after(async () => {
    await rm(path.dirname(storePath), { recursive: true, force: true });
  });

  it("writes and reads back the store correctly", async () => {
    const store: ModelProfileStore = {
      version: 1,
      activeProfile: "fast",
      profiles: {
        fast: {
          model: "openai/gpt-4o-mini",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-abc",
        },
      },
    };
    await saveProfileStore(store, storePath);
    const loaded = await loadProfileStore(storePath);
    assert.equal(loaded.version, 1);
    assert.equal(loaded.activeProfile, "fast");
    assert.deepEqual(loaded.profiles.fast, store.profiles.fast);
  });

  it("creates the file with 0600 permissions (owner-only)", async () => {
    await saveProfileStore(makeStore(), storePath);
    const info = await stat(storePath);
    // 0o100600 = regular file + rw-------
    const mode = info.mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("atomically replaces an existing file", async () => {
    const storeA: ModelProfileStore = {
      version: 1,
      activeProfile: "old",
      profiles: { old: { model: "openai/gpt-3.5-turbo", baseUrl: "https://api.openai.com/v1", apiKey: "sk-old" } },
    };
    const storeB: ModelProfileStore = {
      version: 1,
      activeProfile: "new",
      profiles: { new: { model: "openai/gpt-4o-mini", baseUrl: "https://api.openai.com/v1", apiKey: "sk-new" } },
    };
    await saveProfileStore(storeA, storePath);
    await saveProfileStore(storeB, storePath);
    const loaded = await loadProfileStore(storePath);
    assert.equal(loaded.activeProfile, "new");
    assert.ok("new" in loaded.profiles);
    assert.ok(!("old" in loaded.profiles));
  });
});

// ─── loadProfileStore — validation errors ─────────────────────────────────────

describe("loadProfileStore — validation errors", () => {
  let storePath: string;

  before(async () => {
    storePath = tmpStorePath();
    await mkdir(path.dirname(storePath), { recursive: true });
  });

  after(async () => {
    await rm(path.dirname(storePath), { recursive: true, force: true });
  });

  it("throws ProfileStoreValidationError for malformed JSON", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(storePath, "{not valid json");
    await assert.rejects(
      () => loadProfileStore(storePath),
      ProfileStoreValidationError,
    );
  });

  it("throws ProfileStoreValidationError for wrong schema version", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(storePath, JSON.stringify({ version: 99, activeProfile: null, profiles: {} }));
    await assert.rejects(
      () => loadProfileStore(storePath),
      ProfileStoreValidationError,
    );
  });

  it("throws ProfileStoreValidationError for invalid profile data", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(storePath, JSON.stringify({
      version: 1,
      activeProfile: null,
      profiles: { bad: { model: 42, baseUrl: "https://example.com", apiKey: "" } },
    }));
    await assert.rejects(
      () => loadProfileStore(storePath),
      ProfileStoreValidationError,
    );
  });
});

// ─── upsertProfile ────────────────────────────────────────────────────────────

describe("upsertProfile", () => {
  it("adds a new profile and makes it active by default", () => {
    const store = makeStore();
    const updated = upsertProfile(store, "fast", SAMPLE_PROFILE);
    assert.ok("fast" in updated.profiles);
    assert.equal(updated.activeProfile, "fast");
  });

  it("does not change activeProfile when makeActive=false", () => {
    const store = makeStore({ activeProfile: "existing" });
    const updated = upsertProfile(store, "new-profile", SAMPLE_PROFILE, false);
    assert.equal(updated.activeProfile, "existing");
  });

  it("normalizes baseUrl (strips trailing slash)", () => {
    const store = makeStore();
    const updated = upsertProfile(store, "test", { ...SAMPLE_PROFILE, baseUrl: "https://api.example.com/v1/" });
    assert.equal(updated.profiles.test!.baseUrl, "https://api.example.com/v1");
  });

  it("updates an existing profile in place", () => {
    const store = makeStore({
      activeProfile: "fast",
      profiles: { fast: SAMPLE_PROFILE },
    });
    const updated = upsertProfile(store, "fast", { ...SAMPLE_PROFILE, model: "openai/gpt-4o" });
    assert.equal(updated.profiles.fast!.model, "openai/gpt-4o");
  });

  it("throws for an empty profile name", () => {
    const store = makeStore();
    assert.throws(() => upsertProfile(store, "", SAMPLE_PROFILE));
  });
});

// ─── switchActiveProfile ──────────────────────────────────────────────────────

describe("switchActiveProfile", () => {
  it("changes activeProfile to an existing profile", () => {
    const store = makeStore({
      activeProfile: "a",
      profiles: { a: SAMPLE_PROFILE, b: SAMPLE_PROFILE },
    });
    const updated = switchActiveProfile(store, "b");
    assert.equal(updated.activeProfile, "b");
  });

  it("throws when the profile does not exist", () => {
    const store = makeStore({ profiles: { a: SAMPLE_PROFILE } });
    assert.throws(() => switchActiveProfile(store, "missing"));
  });
});

// ─── deleteProfile ────────────────────────────────────────────────────────────

describe("deleteProfile", () => {
  it("removes the specified profile", () => {
    const store = makeStore({
      activeProfile: "a",
      profiles: { a: SAMPLE_PROFILE, b: SAMPLE_PROFILE },
    });
    const updated = deleteProfile(store, "b");
    assert.ok(!("b" in updated.profiles));
    assert.ok("a" in updated.profiles);
    assert.equal(updated.activeProfile, "a");
  });

  it("resets activeProfile to another when the active profile is deleted", () => {
    const store = makeStore({
      activeProfile: "a",
      profiles: { a: SAMPLE_PROFILE, b: SAMPLE_PROFILE },
    });
    const updated = deleteProfile(store, "a");
    assert.ok(!("a" in updated.profiles));
    assert.equal(updated.activeProfile, "b");
  });

  it("sets activeProfile to null when the last profile is deleted", () => {
    const store = makeStore({
      activeProfile: "only",
      profiles: { only: SAMPLE_PROFILE },
    });
    const updated = deleteProfile(store, "only");
    assert.equal(updated.activeProfile, null);
    assert.deepEqual(updated.profiles, {});
  });

  it("throws when the profile does not exist", () => {
    const store = makeStore({ profiles: { a: SAMPLE_PROFILE } });
    assert.throws(() => deleteProfile(store, "missing"));
  });
});

// ─── getActiveProfile ─────────────────────────────────────────────────────────

describe("getActiveProfile", () => {
  it("returns the active profile data", () => {
    const store = makeStore({
      activeProfile: "fast",
      profiles: { fast: SAMPLE_PROFILE },
    });
    const profile = getActiveProfile(store);
    assert.deepEqual(profile, SAMPLE_PROFILE);
  });

  it("returns null when no active profile is set", () => {
    const store = makeStore({ profiles: { fast: SAMPLE_PROFILE } });
    assert.equal(getActiveProfile(store), null);
  });

  it("returns null when activeProfile points to a missing profile", () => {
    const store = makeStore({ activeProfile: "ghost", profiles: {} });
    assert.equal(getActiveProfile(store), null);
  });
});

// ─── listProfiles ─────────────────────────────────────────────────────────────

describe("listProfiles", () => {
  it("lists all profiles with active flag", () => {
    const store = makeStore({
      activeProfile: "a",
      profiles: { a: SAMPLE_PROFILE, b: { ...SAMPLE_PROFILE, model: "openai/gpt-4o" } },
    });
    const profiles = listProfiles(store);
    assert.equal(profiles.length, 2);
    const a = profiles.find((p) => p.name === "a");
    const b = profiles.find((p) => p.name === "b");
    assert.equal(a?.active, true);
    assert.equal(b?.active, false);
    assert.equal(b?.model, "openai/gpt-4o");
  });

  it("returns empty array for a store with no profiles", () => {
    assert.deepEqual(listProfiles(makeStore()), []);
  });
});

// ─── saveProfile / activateProfile / removeProfile (full disk round-trip) ──────

describe("saveProfile / activateProfile / removeProfile — disk helpers", () => {
  let storePath: string;

  before(async () => {
    storePath = tmpStorePath();
  });

  after(async () => {
    await rm(path.dirname(storePath), { recursive: true, force: true });
  });

  it("saveProfile creates and activates a profile", async () => {
    const store = await saveProfile("myprofile", SAMPLE_PROFILE, true, storePath);
    assert.equal(store.activeProfile, "myprofile");
    assert.ok("myprofile" in store.profiles);
    // Verify persisted
    const loaded = await loadProfileStore(storePath);
    assert.equal(loaded.activeProfile, "myprofile");
  });

  it("activateProfile switches the active profile", async () => {
    // Add second profile first
    await saveProfile("other", { ...SAMPLE_PROFILE, model: "openai/gpt-4o" }, false, storePath);
    const store = await activateProfile("other", storePath);
    assert.equal(store.activeProfile, "other");
    // Verify persisted
    const loaded = await loadProfileStore(storePath);
    assert.equal(loaded.activeProfile, "other");
  });

  it("removeProfile deletes and persists the change", async () => {
    const store = await removeProfile("other", storePath);
    assert.ok(!("other" in store.profiles));
    const loaded = await loadProfileStore(storePath);
    assert.ok(!("other" in loaded.profiles));
  });
});

// ─── Model resolution with active profile ────────────────────────────────────

describe("loadLlmConfigFromEnv — active profile takes precedence", () => {
  let storePath: string;

  before(async () => {
    storePath = tmpStorePath();
    process.env.MINI_AGENT_MODEL_CONFIG = storePath;
  });

  after(async () => {
    delete process.env.MINI_AGENT_MODEL_CONFIG;
    await rm(path.dirname(storePath), { recursive: true, force: true });
  });

  it("loads model from active profile when no env override", async () => {
    // Save a profile to the store
    await saveProfile("coding-fast", {
      model: "openai/gpt-4o-mini",
      baseUrl: "https://gateway.example/v1",
      apiKey: "profile-key-123",
    }, true, storePath);

    // Dynamically import so it picks up the updated store
    const { loadLlmConfigFromEnv } = await import("../src/llm.ts?t=" + Date.now());
    const config = loadLlmConfigFromEnv();
    assert.equal(config.model, "gpt-4o-mini");
    assert.equal(config.baseUrl, "https://gateway.example/v1");
    assert.equal(config.apiKey, "profile-key-123");
  });
});
