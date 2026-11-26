// Builds the `SubagentToolsFactoryDeps` for AgentSessionApp, split out of the
// component's `getSubagentTools` callback.
//
// The factory compares role-LLM configs by JSON value to decide whether to
// rebuild its tool instances, so the deps must be assembled fresh on every
// call with the *live* values (the session role configs come out of a ref
// that changes between calls). Keeping that assembly in a pure function makes
// the wiring testable without React and keeps the component's callback down
// to a one-line forward.

import type { AgentRuntimeRef } from "../loop.ts";
import type { LlmConfig } from "../llm/index.ts";
import type { ToolProvider } from "../tools/types.ts";
import type { MessagePreprocessor } from "../preprocessors/types.ts";
import type { SubagentEvent } from "../subagent/types.ts";
import type { SubagentTaskRegistry } from "../subagent/task-registry.ts";
import type {
  SubagentToolsFactoryDeps,
} from "./subagent-tools-factory.ts";
import { createVisionPreprocessor } from "../preprocessors/index.ts";
import type { VisionConfig } from "../preprocessors/index.ts";

/** Everything the component needs to hand the factory, resolved to values. */
export type SubagentToolsDepsInput = {
  parentLlm: LlmConfig;
  parentTools: ToolProvider;
  taskRegistry: SubagentTaskRegistry;
  /** Vision config from the environment; `undefined` disables preprocessing. */
  vision?: VisionConfig;
  onSubagentEvent: (event: SubagentEvent) => void;
  getPermissionTurn: () => import("../permissions.ts").PermissionTurnContext | undefined;
  getBackgroundPermissionTurn: () => import("../permissions.ts").PermissionTurnContext;
  /** Live runtime ref (identity is read at assembly time, as before). */
  parentRuntime: AgentRuntimeRef;
  globalTokenBudget?: number;
  globalConcurrencyLimit?: number;
  sessionConcurrencyLimit?: number;
  /** Global role->LLM bindings (stable per LLM env). */
  roleLlmConfigs?: Record<string, LlmConfig>;
  /** Live per-session role->LLM overrides (read from a ref each call). */
  sessionRoleLlmConfigs: Record<string, LlmConfig>;
  worktreeSourceCwd: string;
};

/**
 * Assemble the factory deps exactly as the inline `getSubagentTools` body
 * did: vision becomes a one-element preprocessor list, a zero/undefined
 * session concurrency limit is omitted rather than passed as 0, and every
 * field is the value as of this call (the factory re-checks them by value).
 */
export function buildSubagentToolsDeps(input: SubagentToolsDepsInput): SubagentToolsFactoryDeps {
  return {
    parentLlm: input.parentLlm,
    parentTools: input.parentTools,
    taskRegistry: input.taskRegistry,
    visionPreprocessors: input.vision ? [createVisionPreprocessor(input.vision)] : [],
    onSubagentEvent: input.onSubagentEvent,
    getPermissionTurn: input.getPermissionTurn,
    getBackgroundPermissionTurn: input.getBackgroundPermissionTurn,
    parentRuntime: input.parentRuntime,
    globalTokenBudget: input.globalTokenBudget,
    globalConcurrencyLimit: input.globalConcurrencyLimit,
    ...(input.sessionConcurrencyLimit ? { sessionConcurrencyLimit: input.sessionConcurrencyLimit } : {}),
    roleLlmConfigs: input.roleLlmConfigs,
    sessionRoleLlmConfigs: input.sessionRoleLlmConfigs,
    worktreeSourceCwd: input.worktreeSourceCwd,
  };
}
