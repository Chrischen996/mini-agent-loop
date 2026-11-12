import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { commitModelSetup } from "../src/tui/profile-manager.ts";
import type { ModelSetupState } from "../src/tui/types.ts";
import type { LlmConfig } from "../src/llm/index.ts";

let storeDir = "";
let originalStorePath: string | undefined;

const BASE_LLM = {
  provider: "openai",
  model: "gpt-4o-mini",
  api: "openai-completions",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-old",
  reasoning: false,
} as unknown as LlmConfig;

const SETUP: ModelSetupState = {
  model: {
    id: "gpt-5.2",
    name: "GPT-5.2",
    provider: "openai",
    api: "openai-responses",
    protocol: "pi",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: ["OPENAI_API_KEY"],
    capabilities: { input: ["text"], tools: true },
    contextWindow: 400_000,
    maxTokens: 128_000,
    reasoning: true,
    thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high" },
  } as never,
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-new",
  field: "effort",
};

describe("commitModelSetup applies the Effort-slider thinking level", () => {
  beforeEach(async () => {
    storeDir = await mkdtemp(path.join(tmpdir(), "mini-agent-profile-commit-"));
    originalStorePath = process.env.MINI_AGENT_MODEL_CONFIG;
    process.env.MINI_AGENT_MODEL_CONFIG = path.join(storeDir, "models.json");
  });

  afterEach(async () => {
    if (originalStorePath === undefined) delete process.env.MINI_AGENT_MODEL_CONFIG;
    else process.env.MINI_AGENT_MODEL_CONFIG = originalStorePath;
    await rm(storeDir, { recursive: true, force: true });
  });

  it("bakes the chosen level into the committed config when provided", async () => {
    let committed: LlmConfig | undefined;
    await commitModelSetup(SETUP, "sk-new", {
      llm: BASE_LLM,
      setLlm: (llm) => {
        committed = llm;
      },
      setModelSetup: () => {},
      setAcMode: () => {},
      setInput: () => {},
      setAcIndex: () => {},
      setProfileListState: () => {},
      dispatch: () => {},
      historyRef: { current: [] },
    }, { thinkingLevel: "high" });

    assert.ok(committed, "setLlm called with the new config");
    assert.equal((committed as unknown as { model: string }).model, "gpt-5.2");
    assert.equal((committed as unknown as { thinkingLevel?: string }).thinkingLevel, "high");
  });

  it("keeps the model default level when no level is provided (Esc path)", async () => {
    let committed: LlmConfig | undefined;
    await commitModelSetup(SETUP, "sk-new", {
      llm: BASE_LLM,
      setLlm: (llm) => {
        committed = llm;
      },
      setModelSetup: () => {},
      setAcMode: () => {},
      setInput: () => {},
      setAcIndex: () => {},
      setProfileListState: () => {},
      dispatch: () => {},
      historyRef: { current: [] },
    });

    assert.ok(committed, "setLlm called with the new config");
    // Without an explicit level the switch applies the model's own default
    // reasoning level (medium here) — no user override is layered on top.
    assert.equal((committed as unknown as { thinkingLevel?: string }).thinkingLevel, "medium");
  });
});
