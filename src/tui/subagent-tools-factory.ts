import type { LlmConfig } from "../llm/index.ts";
import type { Tool } from "../tools/types.ts";
import type { ToolProvider } from "../tools/types.ts";
import type { AgentRuntimeRef } from "../loop.ts";
import { createSubagentTool, createSubagentBatchTool, defaultProfiles } from "../subagent/index.ts";
import type { SubagentEvent } from "../subagent/types.ts";
import type { MessagePreprocessor } from "../preprocessors/types.ts";
import type { PermissionTurnContext } from "../permissions.ts";

export type SubagentToolsFactoryDeps = {
  parentLlm: LlmConfig;
  parentTools: ToolProvider;
  visionPreprocessors: MessagePreprocessor[];
  onSubagentEvent: (event: SubagentEvent) => void;
  getPermissionTurn: () => PermissionTurnContext | undefined;
  parentRuntime: AgentRuntimeRef;
  globalTokenBudget?: number;
  globalConcurrencyLimit?: number;
  roleLlmConfigs?: Record<string, import("../llm/index.ts").LlmConfig>;
};

/**
 * Factory that creates or reuses subagent tool instances.
 */
export class SubagentToolsFactory {
  private tools: Tool[] | null = null;
  private lastDeps: SubagentToolsFactoryDeps | null = null;

  getTools(deps: SubagentToolsFactoryDeps): Tool[] {
    const keysChanged =
      this.lastDeps === null ||
      JSON.stringify(Object.keys(this.lastDeps?.roleLlmConfigs ?? {})) !==
        JSON.stringify(Object.keys(deps.roleLlmConfigs ?? {}));
    const valuesChanged =
      this.lastDeps === null ||
      JSON.stringify(this.lastDeps?.roleLlmConfigs ?? {}) !==
        JSON.stringify(deps.roleLlmConfigs ?? {});
    const modelChanged =
      this.lastDeps === null || this.lastDeps.parentLlm.model !== deps.parentLlm.model;
    // The deps object is rebuilt on every call, so reference equality is
    // never useful; compare the fields that actually affect tool behaviour.
    if (modelChanged || keysChanged || valuesChanged) {
      const sharedOptions = {
        parentLlm: deps.parentLlm,
        parentTools: deps.parentTools,
        profiles: defaultProfiles,
        preprocessors: deps.visionPreprocessors,
        onSubagentEvent: deps.onSubagentEvent,
        getPermissionTurn: deps.getPermissionTurn,
        parentRuntime: deps.parentRuntime,
        globalTokenBudget: deps.globalTokenBudget,
        globalConcurrencyLimit: deps.globalConcurrencyLimit,
        roleLlmConfigs: deps.roleLlmConfigs,
      };
      this.tools = [
        createSubagentTool(sharedOptions) as Tool,
        createSubagentBatchTool(sharedOptions) as Tool,
      ];
      this.lastDeps = deps;
    }
    return this.tools!;
  }
}
