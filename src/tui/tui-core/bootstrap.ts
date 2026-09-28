// tui-core — platform-agnostic runtime bootstrap for headless consumers.
//
// This module must not import React, Ink, or any terminal renderer.
// The shipped Ink TUI and this module both depend on the shared Agent Core.

import type { LlmConfig } from "../../llm/index.ts";
import { switchLlmModel } from "../../llm/index.ts";
import {
  loadProfileStoreSync,
  resolveSubagentRoleLlmConfigs,
} from "../../profile-store.ts";
import {
  loadGlobalConcurrencyLimitFromEnv,
  loadGlobalTokenBudgetFromEnv,
} from "../../runtime/limits.ts";
import { loadThinkingModeFromEnv } from "../../thinking-policy.ts";
import { createSandboxRunner, type SandboxRunner } from "../../sandbox/index.ts";
import { createCodebaseRuntimeFromEnv, type CodebaseRuntime } from "../../codebase/runtime.ts";
import { createMcpRuntimeFromEnv, type McpRuntime } from "../../mcp/runtime.ts";
import { createTools, createAllTools } from "../../tools/index.ts";
import type { ToolProvider } from "../../tools/types.ts";
import { SubagentToolsFactory } from "../subagent-tools-factory.ts";
import {
  loadAutoSubagentOptionsFromEnv,
  type AutoSubagentOptions,
} from "../../subagent/auto.ts";
import type { SkillRegistry } from "../../skills/types.ts";
import {
  defaultSkillRegistry,
  discoverWorkspaceSkills,
  loadSkillNamesFromEnv,
} from "../../skills/index.ts";
import {
  createVisionPreprocessor,
  loadVisionConfigFromEnv,
  type VisionConfig,
} from "../../preprocessors/index.ts";

export { createVisionPreprocessor, loadVisionConfigFromEnv };
export type { VisionConfig };
export { loadAutoSubagentOptionsFromEnv };
export type { AutoSubagentOptions };
export { defaultSkillRegistry, discoverWorkspaceSkills } from "../../skills/index.ts";
export {
  createSubagentTool,
  createSubagentBatchTool,
  defaultProfiles,
} from "../../subagent/index.ts";
import { defaultProfiles } from "../../subagent/index.ts";
export type { ToolProvider } from "../../tools/types.ts";
export { createTools, createAllTools } from "../../tools/index.ts";

/**
 * Platform-agnostic runtime setup for a headless agent session.
 *
 * Composes sandbox, codebase, MCP, subagent, skill, profile, and budget
 * dependencies for consumers that prefer this factory. The Ink entrypoint
 * retains its own UI-specific composition over the same Agent Core.
 *
 * Callers must `await close()` on shutdown so the MCP server, codebase
 * index and sandbox process are torn down before the process exits.
 */
export type TuiBootstrap = {
  cwd: string;
  sandboxRunner: SandboxRunner | undefined;
  codebase: CodebaseRuntime;
  mcp: McpRuntime;
  baseTools: ToolProvider;
  allTools: ToolProvider;
  subagentFactory: SubagentToolsFactory;
  autoSubagent: AutoSubagentOptions | undefined;
  roleLlmConfigs: Record<string, LlmConfig>;
  globalTokenBudget: number | undefined;
  globalConcurrencyLimit: number | undefined;
  skillNames: string[];
  skillRegistry: SkillRegistry;
  vision: VisionConfig | undefined;
  thinkingMode: "fixed" | "adaptive";
  /**
   * Subagent tool provider pre-composed for the current LLM and subagent
   * settings. `SubagentToolsFactory` caches its result, so re-invoking
   * with the same inputs returns the identical tool set.
   *
   * `onSubagentEvent` / `getPermissionTurn` / `parentRuntime` are
   * entrypoint-specific (they bridge to store dispatch and permission
   * turns), so they are supplied per call.
   */
  subagentTools(wiring: SubagentToolsWiring): import("../../tools/types.ts").Tool[];
  close(): Promise<void>;
};

/**
 * Per-call wiring for `subagentTools`. The factory caches on
 * parentLlm/roleLlmConfigs, so only the entrypoint-specific fields are
 * supplied here; everything else is fixed at bootstrap time.
 */
export type SubagentToolsWiring = {
  parentLlm: LlmConfig;
  onSubagentEvent: (event: import("../../subagent/types.ts").SubagentEvent) => void;
  getPermissionTurn?: () => import("../../permissions.ts").PermissionTurnContext | undefined;
  parentRuntime?: import("../../loop.ts").AgentRuntimeRef;
};

export type TuiBootstrapOptions = {
  cwd?: string;
  /** LLM used to seed role-LLM configs for subagents. */
  llm?: LlmConfig;
  thinkingMode?: "fixed" | "adaptive";
  sandbox?: {
    enabled?: boolean;
    type?: "auto" | "docker" | "node" | "none";
    image?: string;
    allowNetwork?: boolean;
    cpuLimit?: number;
    memoryLimit?: string;
    timeout?: number;
  };
  /** Override env-driven defaults for tests. */
  env?: Record<string, string | undefined>;
};

export async function bootstrapTui(options: TuiBootstrapOptions = {}): Promise<TuiBootstrap> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  const sandboxEnabled =
    options.sandbox?.enabled ??
    (env["MINI_AGENT_SANDBOX"] !== "0" && env["MINI_AGENT_SANDBOX"] !== "false");
  const sandboxType =
    options.sandbox?.type ??
    (env["MINI_AGENT_SANDBOX_TYPE"] as "auto" | "docker" | "node" | "none" | undefined) ?? "auto";
  const allowNetwork = options.sandbox?.allowNetwork ?? env["MINI_AGENT_SANDBOX_NETWORK"] === "true";
  const cpuLimit =
    options.sandbox?.cpuLimit ??
    (env["MINI_AGENT_SANDBOX_CPUS"] ? Number.parseFloat(env["MINI_AGENT_SANDBOX_CPUS"]) : undefined);
  const memoryLimit = options.sandbox?.memoryLimit ?? env["MINI_AGENT_SANDBOX_MEMORY"];
  const timeout =
    options.sandbox?.timeout ??
    (env["MINI_AGENT_SANDBOX_TIMEOUT"] ? Number.parseInt(env["MINI_AGENT_SANDBOX_TIMEOUT"], 10) : undefined);
  const codebase = createCodebaseRuntimeFromEnv();
  let mcp: McpRuntime;
  try {
    mcp = await createMcpRuntimeFromEnv(cwd);
  } catch (error) {
    await codebase.close();
    throw error;
  }

  let sandboxRunner: SandboxRunner | undefined;
  if (sandboxEnabled) {
    try {
      sandboxRunner = await createSandboxRunner({
        enabled: true,
        type: sandboxType,
        dockerImage: options.sandbox?.image ?? env["MINI_AGENT_SANDBOX_IMAGE"],
        allowNetwork,
        cpuLimit,
        memoryLimit,
        timeout,
      });
    } catch (error) {
      process.stderr.write(
        `[sandbox] failed to initialize: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  const codebaseFlag = env["EXTERNAL_CODEBASE_ENABLED"] !== "0";
  const baseTools = mcp.toolProvider(
    createTools(cwd, {
      codebase: codebaseFlag,
      codebaseStore: codebase.store,
      codebaseProvider: codebase.semanticProvider,
      sandboxRunner,
    }),
  );
  const allTools = mcp.toolProvider(createAllTools(cwd, { sandboxRunner }));

  const subagentFactory = new SubagentToolsFactory();
  const vision = loadVisionConfigFromEnv();
  const autoSubagent = loadAutoSubagentOptionsFromEnv();
  const skillNames = loadSkillNamesFromEnv();
  await discoverWorkspaceSkills(cwd).catch(() => undefined);

  const roleLlmConfigs = options.llm ? buildRoleLlmConfigs(options.llm) : {};
  const globalTokenBudget = loadGlobalTokenBudgetFromEnv();
  const globalConcurrencyLimit = loadGlobalConcurrencyLimitFromEnv();
  const activeThinkingMode = options.thinkingMode ?? loadThinkingModeFromEnv();

  return {
    cwd,
    sandboxRunner,
    codebase,
    mcp,
    baseTools,
    allTools,
    subagentFactory,
    autoSubagent,
    roleLlmConfigs,
    globalTokenBudget,
    globalConcurrencyLimit,
    skillNames,
    skillRegistry: defaultSkillRegistry,
    vision,
    thinkingMode: activeThinkingMode,
  subagentTools(wiring: SubagentToolsWiring) {
    return subagentFactory.getTools({
      parentLlm: wiring.parentLlm,
      parentTools: baseTools,
      visionPreprocessors: vision ? [createVisionPreprocessor(vision)] : [],
      onSubagentEvent: wiring.onSubagentEvent,
      getPermissionTurn: wiring.getPermissionTurn ?? (() => undefined),
      parentRuntime: wiring.parentRuntime ?? {},
      globalTokenBudget,
      globalConcurrencyLimit,
      roleLlmConfigs,
    });
  },
    async close() {
      await Promise.all([
        mcp.close(),
        codebase.close(),
        sandboxRunner?.cleanup() ?? Promise.resolve(),
      ]);
    },
  };
}

/**
 * Resolve per-role LLM configs from the profile store. Invalid profiles are
 * skipped silently: the subagent falls back to the parent model.
 */
export function buildRoleLlmConfigs(parentLlm: LlmConfig): Record<string, LlmConfig> {
  const store = loadProfileStoreSync();
  if (!store) return {};
  const roleProfiles = resolveSubagentRoleLlmConfigs(store);
  const result: Record<string, LlmConfig> = {};
  for (const [role, profile] of Object.entries(roleProfiles)) {
    try {
      result[role] = switchLlmModel(parentLlm, profile.model, {
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
      });
    } catch {
      // profile invalid → skip, subagent falls back to parent model
    }
  }
  return result;
}
