import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeLlmConfig } from "../src/llm/index.ts";
import {
  restoreTuiModelConfig,
  serializeTuiModelConfig,
  restoreTuiLlmConfig,
  resolveTuiSubagentRoleConfigs,
} from "../src/tui/model-isolation.ts";
import type { PersistedSession } from "../src/session-store.ts";

const defaultLlm = () => makeLlmConfig({
  apiKey: "default-key",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
});

describe("TUI model isolation", () => {
  it("persists and restores the full selected model connection", () => {
    const selected = makeLlmConfig({
      apiKey: "session-secret",
      baseUrl: "https://gateway.example/v1",
      model: "gpt-4o-mini",
    });
    const snapshot = serializeTuiModelConfig(selected);
    assert.equal(snapshot?.apiKey, "session-secret");
    assert.equal(snapshot?.baseUrl, "https://gateway.example/v1");
    const restored = restoreTuiModelConfig(defaultLlm(), snapshot);
    assert.equal(restored?.apiKey, "session-secret");
    assert.equal(restored?.baseUrl, "https://gateway.example/v1");
    assert.equal(restored?.model, selected.model);
  });

  it("uses the default model and warns instead of treating an unknown qualified id as a custom model", () => {
    const session = {
      modelId: "missing-provider/deleted-model",
    } as PersistedSession;
    const result = restoreTuiLlmConfig(defaultLlm(), session);
    assert.equal(result.config.model, "gpt-4o-mini");
    assert.equal(result.warning, "missing-provider/deleted-model");
  });

  it("restores every serializable runtime setting from a session snapshot", () => {
    const selected = {
      ...makeLlmConfig({
        apiKey: "session-secret",
        baseUrl: "https://gateway.example/v1",
        model: "gpt-4o-mini",
      }),
      timeoutMs: 45_000,
      compat: { customFlag: true },
    };
    const snapshot = serializeTuiModelConfig(selected);
    const restored = restoreTuiModelConfig(defaultLlm(), snapshot);
    assert.equal(restored?.timeoutMs, 45_000);
    assert.deepEqual(restored?.compat, { customFlag: true });
    assert.equal(restored?.apiKey, "session-secret");
  });

  it("returns only the explicitly selected role bindings when starting a new conversation", () => {
    const local = makeLlmConfig({ apiKey: "local-key", baseUrl: "https://local.example/v1", model: "gpt-4o-mini" });
    assert.deepEqual(resolveTuiSubagentRoleConfigs(undefined, undefined), {});
    assert.equal(resolveTuiSubagentRoleConfigs({ researcher: local }, undefined).researcher?.apiKey, "local-key");
  });

  it("prefers conversation-specific role bindings over global role bindings", () => {
    const local = makeLlmConfig({ apiKey: "local-key", baseUrl: "https://local.example/v1", model: "gpt-4o-mini" });
    const global = makeLlmConfig({ apiKey: "global-key", baseUrl: "https://global.example/v1", model: "gpt-4o-mini" });
    assert.equal(resolveTuiSubagentRoleConfigs({ researcher: local }, { researcher: global }).researcher?.apiKey, "local-key");
    assert.equal(resolveTuiSubagentRoleConfigs({}, { researcher: global }).researcher?.apiKey, "global-key");
  });
});
