import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { selectModel, type ModelSwitcherCallbacks } from "../src/tui/model-switcher.ts";

const MODEL = "xai/grok-build-0.1";
let storeDir = "";
let originalStorePath: string | undefined;

async function writeStore(
  profiles: Record<string, { model: string; baseUrl: string; apiKey: string }>,
  activeProfile: string | null = null,
): Promise<void> {
  await writeFile(path.join(storeDir, "models.json"), JSON.stringify({
    version: 1,
    activeProfile,
    profiles,
  }));
}

function callbacks(calls: string[]): ModelSwitcherCallbacks {
  return {
    openModelPicker: () => { calls.push("model-picker"); },
    openProfileList: (names) => { calls.push(`profile-list:${names?.join(",") ?? "all"}`); },
    activateSavedProfile: (name) => { calls.push(`activate:${name}`); },
    commitModelSetup: async () => { calls.push("commit"); },
    startModelSetup: () => { calls.push("setup"); },
  };
}

describe("model selection reuses saved profiles", () => {
  beforeEach(async () => {
    storeDir = await mkdtemp(path.join(tmpdir(), "mini-agent-model-switcher-"));
    originalStorePath = process.env.MINI_AGENT_MODEL_CONFIG;
    process.env.MINI_AGENT_MODEL_CONFIG = path.join(storeDir, "models.json");
  });

  afterEach(async () => {
    if (originalStorePath === undefined) delete process.env.MINI_AGENT_MODEL_CONFIG;
    else process.env.MINI_AGENT_MODEL_CONFIG = originalStorePath;
    await rm(storeDir, { recursive: true, force: true });
  });

  it("activates the only saved profile for a selected model", async () => {
    await writeStore({
      "grok-build": { model: MODEL, baseUrl: "https://gateway.example/v1", apiKey: "sk-test" },
    });
    const calls: string[] = [];

    selectModel(MODEL, {}, callbacks(calls));

    assert.deepEqual(calls, ["activate:grok-build"]);
  });

  it("prefers the active matching profile when a model has multiple configurations", async () => {
    await writeStore({
      "grok-build-direct": { model: MODEL, baseUrl: "https://api.x.ai/v1", apiKey: "sk-direct" },
      "grok-build-relay": { model: MODEL, baseUrl: "https://gateway.example/v1", apiKey: "sk-relay" },
    }, "grok-build-relay");
    const calls: string[] = [];

    selectModel(MODEL, {}, callbacks(calls));

    assert.deepEqual(calls, ["activate:grok-build-relay"]);
  });

  it("shows only matching profiles when multiple saved configurations are ambiguous", async () => {
    await writeStore({
      "grok-build-direct": { model: MODEL, baseUrl: "https://api.x.ai/v1", apiKey: "sk-direct" },
      "grok-build-relay": { model: MODEL, baseUrl: "https://gateway.example/v1", apiKey: "sk-relay" },
      "other-model": { model: "openai/gpt-4o", baseUrl: "https://api.openai.com/v1", apiKey: "sk-other" },
    });
    const calls: string[] = [];

    selectModel(MODEL, {}, callbacks(calls));

    assert.deepEqual(calls, ["profile-list:grok-build-direct,grok-build-relay"]);
  });

  it("honors an explicit gateway override instead of reusing a saved profile", async () => {
    await writeStore({
      "grok-build": { model: MODEL, baseUrl: "https://gateway.example/v1", apiKey: "sk-saved" },
    });
    const calls: string[] = [];

    selectModel(MODEL, { baseUrl: "https://other-gateway.example/v1" }, callbacks(calls));

    assert.deepEqual(calls, ["setup"]);
  });
});
