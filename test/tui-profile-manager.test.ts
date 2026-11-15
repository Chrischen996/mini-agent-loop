import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeLlmConfig } from "../src/llm/config.ts";
import { getAllModels, resolveModel } from "../src/models.ts";
import { loadProfileStore } from "../src/profile-store.ts";
import {
  commitModelSetup,
  startModelSetup,
  type ProfileManagerDeps,
} from "../src/tui/profile-manager.ts";

describe("model setup reuses configured provider credentials", () => {
  let storeDir = "";
  let storePath = "";
  let originalStorePath: string | undefined;
  let originalXaiKey: string | undefined;

  beforeEach(async () => {
    storeDir = await mkdtemp(path.join(tmpdir(), "mini-agent-profile-manager-"));
    storePath = path.join(storeDir, "models.json");
    originalStorePath = process.env.MINI_AGENT_MODEL_CONFIG;
    originalXaiKey = process.env.XAI_API_KEY;
    process.env.MINI_AGENT_MODEL_CONFIG = storePath;
    process.env.XAI_API_KEY = "sk-test-xai";
  });

  afterEach(async () => {
    if (originalStorePath === undefined) delete process.env.MINI_AGENT_MODEL_CONFIG;
    else process.env.MINI_AGENT_MODEL_CONFIG = originalStorePath;
    if (originalXaiKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = originalXaiKey;
    await rm(storeDir, { recursive: true, force: true });
  });

  it("switches to a catalog model without opening setup or persisting the environment key", async () => {
    const model = getAllModels().find((candidate) => candidate.provider === "xai" && candidate.id === "grok-build-0.1");
    assert.ok(model);

    const base = makeLlmConfig({ apiKey: "sk-old", baseUrl: "https://old.example/v1", model: "gpt-4o-mini" });
    let applied = base;
    let setupOpened = false;
    const deps: ProfileManagerDeps = {
      llm: base,
      setLlm: (next) => { applied = next; },
      setModelSetup: (setup) => { if (setup) setupOpened = true; },
      setAcMode: (mode) => { if (mode === "model-setup") setupOpened = true; },
      setInput: () => undefined,
      setAcIndex: () => undefined,
      setProfileListState: () => undefined,
      dispatch: () => undefined,
      historyRef: { current: [] },
    };

    await startModelSetup(model, {}, deps);

    assert.equal(applied.model, model.id);
    assert.equal(applied.provider, model.provider);
    assert.equal(applied.baseUrl, model.baseUrl);
    assert.equal(applied.apiKey, "sk-test-xai");
    assert.equal(setupOpened, false);
    assert.equal(existsSync(storePath), false);
  });
});

describe("commitModelSetup profile persistence", () => {
  it("saves the selected config's resolved base URL and API key", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-agent-tui-profile-manager-"));
    const storePath = path.join(directory, "models.json");
    const originalStorePath = process.env.MINI_AGENT_MODEL_CONFIG;
    process.env.MINI_AGENT_MODEL_CONFIG = storePath;

    try {
      const llm = makeLlmConfig({
        apiKey: "previous-key",
        baseUrl: "https://previous.example/v1",
        model: "openai/gpt-4o-mini",
      });
      const model = resolveModel("openai/gpt-4o-mini");
      let selectedConfig: typeof llm | undefined;
      let persistedConfig: typeof llm | undefined;

      await commitModelSetup(
        { model, baseUrl: "", apiKey: "", field: "apiKey" },
        "selected-key",
        {
          llm,
          setLlm: (config) => { selectedConfig = config; },
          setModelSetup: () => undefined,
          setAcMode: () => undefined,
          setInput: () => undefined,
          setAcIndex: () => undefined,
          setProfileListState: () => undefined,
          dispatch: () => undefined,
          historyRef: { current: [] },
          persistSession: async (_history, config) => { persistedConfig = config; },
        },
      );

      assert.ok(selectedConfig);
      assert.equal(persistedConfig, selectedConfig);
      assert.equal(persistedConfig.apiKey, "selected-key");
      assert.equal(persistedConfig.baseUrl, model.baseUrl);

      const store = await loadProfileStore(storePath);
      const saved = store.profiles["openai-gpt-4o-mini"];
      assert.ok(saved, `saved profiles: ${Object.keys(store.profiles).join(", ")}`);
      assert.equal(saved.apiKey, persistedConfig.apiKey);
      assert.equal(saved.baseUrl, persistedConfig.baseUrl);
    } finally {
      if (originalStorePath === undefined) delete process.env.MINI_AGENT_MODEL_CONFIG;
      else process.env.MINI_AGENT_MODEL_CONFIG = originalStorePath;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
