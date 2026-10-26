/**
 * Persisted custom-provider model resolution.
 *
 * Regression coverage for a silent failure: a model belonging to a provider
 * saved from the Web settings page was invisible to `resolveModel`, so its id
 * resolved onto the default OpenAI endpoint and inherited an unrelated
 * `OPENAI_API_KEY`. Requests for a third-party gateway went to the wrong host.
 *
 * The profile store path is redirected to a temp file so the test never reads
 * or writes the developer's real store.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  clearPersistedCustomProviderModelsOverride,
  resolveModel,
  getAllModels,
} from "../src/models.ts";
import { switchLlmModel, makeLlmConfig } from "../src/llm/index.ts";

const PROVIDER = "mythirdparty";
const MODEL_ID = "acme-reasoner-9";
const QUALIFIED = `${PROVIDER}/${MODEL_ID}`;
const BASE_URL = "https://api.thirdparty.example/v1";
const SECRET = "sk-thirdparty-secret";

/** Write a store containing one custom provider and point the app at it. */
async function withStore(
  providers: Record<string, unknown>,
  fn: (storePath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mini-agent-provider-"));
  const storePath = join(dir, "models.json");
  await writeFile(storePath, JSON.stringify({
    version: 1,
    activeProfile: null,
    profiles: {},
    customProviders: providers,
  }, null, 2));
  const previous = process.env.MINI_AGENT_MODEL_CONFIG;
  process.env.MINI_AGENT_MODEL_CONFIG = storePath;
  try {
    await fn(storePath);
  } finally {
    if (previous === undefined) delete process.env.MINI_AGENT_MODEL_CONFIG;
    else process.env.MINI_AGENT_MODEL_CONFIG = previous;
    // Reset the memoized overlay so later tests see a clean catalog.
    clearPersistedCustomProviderModelsOverride();
  }
}

function providerProfile(overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: BASE_URL,
    protocol: "openai-completions",
    apiKey: SECRET,
    models: [{ id: MODEL_ID, name: "Acme Reasoner 9" }],
    ...overrides,
  };
}

const parent = makeLlmConfig({
  apiKey: "sk-parent-openai-key",
  baseUrl: "https://api.openai.com/v1",
  model: "openai/gpt-4o-mini",
  provider: "openai",
});

afterEach(() => {
  clearPersistedCustomProviderModelsOverride();
});

describe("persisted custom provider models", () => {
  it("resolves a persisted provider model onto its own endpoint", async () => {
    await withStore({ [PROVIDER]: providerProfile() }, async () => {
      const resolved = resolveModel(QUALIFIED);
      // The catalog entry keeps the bare model id with its provider alongside.
      assert.equal(resolved.id, MODEL_ID);
      assert.equal(resolved.provider, PROVIDER);
      assert.equal(resolved.baseUrl, BASE_URL);
      // The key must come from the provider, not from the OpenAI env var.
      assert.deepEqual(resolved.apiKeyEnv, []);
      assert.equal(resolved.apiKey, SECRET);
    });
  });

  it("keeps the custom model in the catalog", async () => {
    await withStore({ [PROVIDER]: providerProfile() }, async () => {
      assert.ok(
        getAllModels().some((model) => model.provider === PROVIDER && model.id === MODEL_ID),
        "the custom provider model should be part of the catalog",
      );
    });
  });

  it("switchLlmModel targets the provider endpoint with the provider key", async () => {
    await withStore({ [PROVIDER]: providerProfile() }, async () => {
      const next = switchLlmModel(parent, QUALIFIED);
      assert.equal(next.baseUrl, BASE_URL);
      assert.equal(next.apiKey, SECRET);
      assert.equal(next.model, MODEL_ID);
      assert.equal(next.provider, PROVIDER);
    });
  });

  it("still resolves a legacy dotted alias and unknown ids as before", async () => {
    await withStore({}, async () => {
      assert.equal(resolveModel("claude-sonnet-4.6").provider, "anthropic");
      // An unknown id keeps the documented openai-compatible fallback.
      const unknown = switchLlmModel(parent, "totally-unknown-model");
      assert.equal(unknown.baseUrl, "https://api.openai.com/v1");
      assert.equal(unknown.apiKey, "sk-parent-openai-key");
    });
  });

  it("ignores a malformed store instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mini-agent-provider-bad-"));
    const storePath = join(dir, "models.json");
    // Invalid: protocol is not one of the accepted values.
    await writeFile(storePath, JSON.stringify({
      version: 1,
      activeProfile: null,
      profiles: {},
      customProviders: { [PROVIDER]: providerProfile({ protocol: "nope" }) },
    }));
    const previous = process.env.MINI_AGENT_MODEL_CONFIG;
    process.env.MINI_AGENT_MODEL_CONFIG = storePath;
    try {
      clearPersistedCustomProviderModelsOverride();
      assert.equal(resolveModel(QUALIFIED).provider, "custom");
    } finally {
      if (previous === undefined) delete process.env.MINI_AGENT_MODEL_CONFIG;
      else process.env.MINI_AGENT_MODEL_CONFIG = previous;
      clearPersistedCustomProviderModelsOverride();
    }
  });
});