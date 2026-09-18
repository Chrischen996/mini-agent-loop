// 端到端集成测试：/multi-agent 向导配完子角色模型后，roleLlmConfigs 正确
// 注入 subagent 工具，且 factory 在配置变化时重建。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadProfileStore,
  saveProfile,
  saveSubagentRole,
  resolveSubagentRoleLlmConfigs,
} from "../src/profile-store.ts";
import { SubagentToolsFactory } from "../src/tui/subagent-tools-factory.ts";
import type { LlmConfig } from "../src/llm/index.ts";

const TEST_PROFILE = "ma-integration-test";

function makeLlm(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    model: "deepseek/deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "test-key",
    ...overrides,
  } as LlmConfig;
}

async function withProfile(name: string, profile: Parameters<typeof saveProfile>[1], fn: () => Promise<void>): Promise<void> {
  await saveProfile(name, profile, false);
  try {
    await fn();
  } finally {
    const store = await loadProfileStore();
    delete store.profiles[name];
    const { saveProfileStore } = await import("../src/profile-store.ts");
    await saveProfileStore(store);
  }
}

describe("multi-agent role model setup end-to-end", () => {
  it("resolves roleLlmConfigs after subagentRoles binding", async () => {
    await withProfile(TEST_PROFILE, {
      model: "openai/gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    }, async () => {
      const store = await loadProfileStore();
      const updated = await saveSubagentRole("coder", TEST_PROFILE);
      const resolved = resolveSubagentRoleLlmConfigs(updated);
      assert.ok(resolved.coder);
      assert.equal(resolved.coder.model, "openai/gpt-4o-mini");
      assert.equal(resolved.coder.baseUrl, "https://api.openai.com/v1");
    });
  });

  it("factory rebuilds tools when roleLlmConfigs content changes", () => {
    const factory = new SubagentToolsFactory();
    const parentLlm = makeLlm();
    const noopEvent = (): void => {};
    const noopPermission = (): undefined => undefined;
    const noopRuntime = {} as never;

    const emptyDeps = {
      parentLlm,
      parentTools: { list: () => [] } as never,
      visionPreprocessors: [],
      onSubagentEvent: noopEvent,
      getPermissionTurn: noopPermission,
      parentRuntime: noopRuntime,
    };

    const first = factory.getTools(emptyDeps);
    const roleConfigured = {
      ...emptyDeps,
      roleLlmConfigs: {
        coder: makeLlm({ model: "openai/gpt-4o-mini", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" }),
      },
    };
    const second = factory.getTools(roleConfigured);
    // First call: no roleLlmConfigs. Second: same keys but new values → rebuild.
    assert.notEqual(first, second);

    // Calling again with the same instance content reuses the cache.
    const third = factory.getTools(roleConfigured);
    assert.equal(second, third);
  });
});
