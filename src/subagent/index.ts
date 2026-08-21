/**
 * Subagent module — nested agent loop support.
 *
 * @example Basic usage
 * ```ts
 * import { createSubagentTool } from "./subagent/index.ts";
 *
 * const subagentTool = createSubagentTool({
 *   parentLlm: llmConfig,
 *   parentTools: existingTools,
 *   profiles: [
 *     {
 *       name: "researcher",
 *       description: "Reads and analyzes files to gather information",
 *       systemPrompt: "You are a research assistant. Read files and summarize findings.",
 *       allowedTools: ["read", "grep", "find", "ls"],
 *       maxTurns: 8,
 *     },
 *     {
 *       name: "coder",
 *       description: "Writes and edits code files",
 *       systemPrompt: "You are a coding assistant. Write clean, well-tested code.",
 *       allowedTools: ["read", "write", "edit"],
 *       maxTurns: 10,
 *     },
 *   ],
 * });
 *
 * // Add to parent tool set
 * tools.push(subagentTool);
 * ```
 */

export { createSubagentTool, createSubagentBatchTool, allocateBatchTokenBudgets } from "./tool.ts";

export {
  buildCoordinatorPromptFragment,
  buildPreflightTask,
  decideAutoSubagent,
  DEFAULT_MAX_DIRECT_EXPLORATION,
  DEFAULT_MIN_SCORE,
  DELEGATION_TOOL_NAMES,
  EXPLORATION_TOOL_NAMES,
  loadAutoSubagentOptionsFromEnv,
} from "./auto.ts";

export {
  defaultProfiles,
  researcherProfile,
  coderProfile,
  reviewerProfile,
} from "./profiles.ts";

export type {
  SubagentArgs,
  SubagentBatchArgs,
  SubagentBatchTask,
  SubagentCost,
  SubagentEvent,
  SubagentErrorKind,
  SubagentProfile,
  SubagentTokenBreakdown,
  SubagentToolOptions,
} from "./types.ts";

export { calculateSubagentCost } from "./cost.ts";

export type {
  AutoSubagentDecision,
  AutoSubagentOptions,
} from "./auto.ts";
