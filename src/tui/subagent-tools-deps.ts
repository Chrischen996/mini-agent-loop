// Builds the `SubagentToolsFactoryDeps` for AgentSessionApp, split out of the
// component's `getSubagentTools` callback.
//
// The factory compares role-LLM configs by JSON value to decide whether to
// rebuild its tool instances, so the deps must be assembled fresh on every
// call with the *live* values (the session role configs come out of a ref
// that changes between calls). Keeping that assembly in a pure function makes
// the wiring testable without React and keeps the component's callback down
// to a one-line forward.

import type { LlmConfig } from "../llm/index.ts";
import type { SubagentTaskRegistry } from "../subagent/task-registry.ts";
import type {
  SubagentToolsFactoryDeps,
} from "./subagent-tools-factory.ts";
import { createVisionPreprocessor } from "../preprocessors/index.ts";
import type { VisionConfig } from "../preprocessors/index.ts";
import type { PermissionTurnContext } from "../permissions.ts";

/**
 * Everything the component needs to hand the factory, resolved to values.
 *
 * Derived from `SubagentToolsFactoryDeps` rather than re-declared: a new
 * optional dep added to the factory is accepted and forwarded automatically,
 * so it can never be silently dropped here. Only the fields whose *input*
 * shape differs are overridden:
 * - `visionPreprocessors` is supplied as a `vision` config and expanded below,
 * - fields the factory treats as optional are required of the component,
 *   because the component always has them.
 */
export type SubagentToolsDepsInput =
  Omit<
    SubagentToolsFactoryDeps,
    | "visionPreprocessors"
    | "taskRegistry"
    | "getBackgroundPermissionTurn"
    | "sessionRoleLlmConfigs"
    | "worktreeSourceCwd"
  > & {
    taskRegistry: SubagentTaskRegistry;
    getBackgroundPermissionTurn: () => PermissionTurnContext;
    sessionRoleLlmConfigs: Record<string, LlmConfig>;
    worktreeSourceCwd: string;
    /** Vision config from the environment; `undefined` disables preprocessing. */
    vision?: VisionConfig;
  };

/**
 * Assemble the factory deps exactly as the inline `getSubagentTools` body
 * did: vision becomes a one-element preprocessor list, a zero/undefined
 * session concurrency limit is omitted rather than passed as 0, and every
 * other field is forwarded as of this call (the factory re-checks them by
 * value).
 */
export function buildSubagentToolsDeps(input: SubagentToolsDepsInput): SubagentToolsFactoryDeps {
  const { vision, sessionConcurrencyLimit, ...rest } = input;
  return {
    ...rest,
    visionPreprocessors: vision ? [createVisionPreprocessor(vision)] : [],
    ...(sessionConcurrencyLimit ? { sessionConcurrencyLimit } : {}),
  };
}
