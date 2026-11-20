import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeLlmConfig } from "../src/llm/config.ts";
import { getAllModels } from "../src/models.ts";
import {
  activateSavedModelProfile,
  commitModelSetup,
  deleteConfiguredModelProfile,
  resolveModelDeleteConfirmation,
  startModelSetup,
  type ProfileManagerDeps,
} from "../src/tui/profile-manager.ts";
import type { ModelSetupState } from "../src/tui/types.ts";
import { loadProfileStore } from "../src/profile-store.ts";
import { saveProfile } from "../src/profile-store.ts";
import { resolveModel } from "../src/models.ts";

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

  it("opens a setup form with an empty API key when forceSetup is requested", async () => {
    const model = getAllModels().find((candidate) => candidate.provider === "xai" && candidate.id === "grok-build-0.1");
    assert.ok(model);

    const base = makeLlmConfig({ apiKey: "sk-old", baseUrl: "https://old.example/v1", model: "gpt-4o-mini" });
    let applied = base;
    let openedField: "baseUrl" | "apiKey" | "effort" | "deleteConfirm" | undefined;
    let openedApiKey = "";
    const deps: ProfileManagerDeps = {
      llm: base,
      setLlm: (next) => { applied = next; },
      setModelSetup: (setup) => { if (setup) { openedField = setup.field; openedApiKey = setup.apiKey; } },
      setAcMode: () => undefined,
      setInput: () => undefined,
      setAcIndex: () => undefined,
      setProfileListState: () => undefined,
      dispatch: () => undefined,
      historyRef: { current: [] },
    };

    await startModelSetup(model, {}, deps, { forceSetup: true });

    // The form is opened instead of silently committing. The API key field is
    // left empty even though an environment key exists: the All models section
    // must re-enter the key instead of reusing it silently.
    assert.equal(openedField, "baseUrl");
    assert.equal(openedApiKey, "");
    assert.equal(applied.model, base.model, "model config must not switch until the form is committed");
  });

  it("honors an explicit --api-key override as the forceSetup prefill", async () => {
    const model = getAllModels().find((candidate) => candidate.provider === "xai" && candidate.id === "grok-build-0.1");
    assert.ok(model);

    const base = makeLlmConfig({ apiKey: "sk-old", baseUrl: "https://old.example/v1", model: "gpt-4o-mini" });
    let openedApiKey = "unset";
    const deps: ProfileManagerDeps = {
      llm: base,
      setLlm: () => undefined,
      setModelSetup: (setup) => { openedApiKey = setup?.apiKey ?? ""; },
      setAcMode: () => undefined,
      setInput: () => undefined,
      setAcIndex: () => undefined,
      setProfileListState: () => undefined,
      dispatch: () => undefined,
      historyRef: { current: [] },
    };

    await startModelSetup(model, { apiKey: "sk-explicit" }, deps, { forceSetup: true });

    assert.equal(openedApiKey, "sk-explicit");
  });

  it("rejects a blank All models API key instead of reusing a saved or environment key", async () => {
    const model = getAllModels().find((candidate) => candidate.provider === "xai" && candidate.id === "grok-build-0.1");
    assert.ok(model);
    await saveProfile("saved-gateway", {
      model: "xai/grok-build-0.1",
      baseUrl: "https://gateway.example/v1",
      apiKey: "sk-saved",
    });

    const base = makeLlmConfig({ apiKey: "sk-current", baseUrl: model.baseUrl, model: "gpt-4o-mini" });
    let applied = base;
    let retained: ModelSetupState | undefined;
    const deps: ProfileManagerDeps = {
      llm: base,
      setLlm: (next) => { applied = next; },
      setModelSetup: (setup) => { retained = setup; },
      setAcMode: () => undefined,
      setInput: () => undefined,
      setAcIndex: () => undefined,
      setProfileListState: () => undefined,
      dispatch: () => undefined,
      historyRef: { current: [] },
    };

    await startModelSetup(model, {}, deps, { forceSetup: true });
    const opened = retained;
    assert.ok(opened);
    await commitModelSetup(opened, "   ", deps);

    assert.equal(applied.apiKey, "sk-current");
    assert.equal(applied.model, base.model);
    assert.equal(retained?.field, "apiKey");
    assert.match(retained?.error ?? "", /API key/i);
    assert.equal(existsSync(storePath), true);
    const store = await loadProfileStore(storePath);
    assert.equal(store.profiles["xai-grok-build-0-1"], undefined);
  });

  it("explains that a saved profile supplies the base URL and key", async () => {
    await saveProfile("saved-gateway", {
      model: "xai/grok-build-0.1",
      baseUrl: "https://gateway.example/v1",
      apiKey: "sk-saved",
    });
    const base = makeLlmConfig({ apiKey: "sk-old", baseUrl: "https://old.example/v1", model: "gpt-4o-mini" });
    const actions: Array<{ type: string; [key: string]: unknown }> = [];
    const deps: ProfileManagerDeps = {
      llm: base,
      setLlm: () => undefined,
      setModelSetup: () => undefined,
      setAcMode: () => undefined,
      setInput: () => undefined,
      setAcIndex: () => undefined,
      setProfileListState: () => undefined,
      dispatch: (action) => { actions.push(action as { type: string }); },
      historyRef: { current: [] },
    };

    await activateSavedModelProfile("saved-gateway", deps);

    const notice = actions.find((action) => action.type === "ADD_NOTICE");
    assert.deepEqual(notice, {
      type: "ADD_NOTICE",
      title: "Model",
      text: 'Activated saved profile "saved-gateway" (https://gateway.example/v1); using its saved API key.',
    });
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

describe("configure model delete confirmation", () => {
  const model = resolveModel("openai/gpt-4o-mini");
  const setup: ModelSetupState = {
    model,
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    field: "baseUrl",
  };

  it("asks before deleting and only accepts an explicit yes", () => {
    assert.equal(resolveModelDeleteConfirmation(setup, "delete").action, "confirm");
    assert.equal(resolveModelDeleteConfirmation(setup, "d").action, "confirm");
    assert.equal(resolveModelDeleteConfirmation(setup, "https://gateway.example/v1").action, "continue");

    const confirming: ModelSetupState = { ...setup, field: "deleteConfirm" };
    assert.deepEqual(resolveModelDeleteConfirmation(confirming, "y"), {
      action: "delete",
      profileName: "openai-gpt-4o-mini",
    });
    assert.equal(resolveModelDeleteConfirmation(confirming, "yes").action, "delete");
    assert.equal(resolveModelDeleteConfirmation(confirming, "n").action, "cancel");
    assert.equal(resolveModelDeleteConfirmation(confirming, "no").action, "cancel");
    assert.equal(resolveModelDeleteConfirmation(confirming, "").action, "continue");
  });

  it("deletes the saved profile only after confirmation, and reports a missing profile", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-agent-model-delete-"));
    const storePath = path.join(directory, "models.json");
    const originalStorePath = process.env.MINI_AGENT_MODEL_CONFIG;
    process.env.MINI_AGENT_MODEL_CONFIG = storePath;
    try {
      await saveProfile("openai-gpt-4o-mini", {
        model: "openai/gpt-4o-mini",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
      });
      assert.equal(resolveModelDeleteConfirmation(setup, "n").action, "continue");
      const kept = await loadProfileStore(storePath);
      assert.ok(kept.profiles["openai-gpt-4o-mini"]);

      const deleted = await deleteConfiguredModelProfile({ ...setup, field: "deleteConfirm" });
      assert.equal(deleted.profileName, "openai-gpt-4o-mini");
      const store = await loadProfileStore(storePath);
      assert.equal(store.profiles["openai-gpt-4o-mini"], undefined);

      await assert.rejects(
        () => deleteConfiguredModelProfile({ ...setup, field: "deleteConfirm" }),
        /does not exist/,
      );
    } finally {
      if (originalStorePath === undefined) delete process.env.MINI_AGENT_MODEL_CONFIG;
      else process.env.MINI_AGENT_MODEL_CONFIG = originalStorePath;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
