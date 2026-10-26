import type { LlmConfig } from "../llm/index.ts";
import type { Tool } from "../tools/types.ts";
import type { ToolProvider } from "../tools/types.ts";
import type { AgentRuntimeRef } from "../loop.ts";
import { createSubagentTool, createSubagentBatchTool, defaultProfiles } from "../subagent/index.ts";
import type { SubagentEvent } from "../subagent/types.ts";
import type { SubagentArgs } from "../subagent/types.ts";
import type { MessagePreprocessor } from "../preprocessors/types.ts";
import type { PermissionTurnContext } from "../permissions.ts";
import { createSearchOrchestrationTool } from "../orchestration/search-orchestrator.ts";
import type { SearchOrchestrationEvent } from "../orchestration/search-orchestrator.ts";

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
  /** Enable the `search_orchestrate` tool. Default: false. */
  searchOrchestrationEnabled?: boolean;
  /**
   * Models the search orchestrator may assign to tasks. Typically the same
   * catalog (plus persisted custom providers) the host advertises.
   */
  orchestratorModels?: () => Array<{ id: string; provider: string; name?: string }>;
  /** Map a complexity hint to a concrete model id for orchestrated tasks. */
  orchestratorModelMapping?: Partial<Record<"light" | "standard" | "flagship", string>>;
  /** Structured progress callback for the search orchestrator. */
  onSearchOrchestrationEvent?: (event: SearchOrchestrationEvent) => void;
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
    const orchestrationChanged =
      this.lastDeps === null ||
      Boolean(this.lastDeps.searchOrchestrationEnabled) !== Boolean(deps.searchOrchestrationEnabled) ||
      JSON.stringify(this.lastDeps.orchestratorModelMapping ?? {}) !==
        JSON.stringify(deps.orchestratorModelMapping ?? {});
    // The deps object is rebuilt on every call, so reference equality is
    // never useful; compare the fields that actually affect tool behaviour.
    if (modelChanged || keysChanged || valuesChanged || orchestrationChanged) {
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
      const subagent = createSubagentTool(sharedOptions) as Tool<SubagentArgs>;
      const tools: Tool[] = [
        subagent as Tool,
        createSubagentBatchTool(sharedOptions) as Tool,
      ];
      if (deps.searchOrchestrationEnabled) {
        // Route orchestrated subagent calls through the tool built above so
        // they inherit the host's permissions, budgets and role bindings.
        // Progress is reported through `onSearchOrchestrationEvent` when the
        // host supplies it; individual subagent calls still surface their own
        // subagent events through `onSubagentEvent`.
        tools.push(createSearchOrchestrationTool({
          subagent,
          models: deps.orchestratorModels?.() ?? [],
          ...(deps.orchestratorModelMapping ? { modelMapping: deps.orchestratorModelMapping } : {}),
          ...(deps.onSearchOrchestrationEvent
            ? { onEvent: deps.onSearchOrchestrationEvent }
            : {}),
        }));
      }
      this.tools = tools;
      this.lastDeps = deps;
    }
    return this.tools!;
  }
}
