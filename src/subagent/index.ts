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
 *       allowedTools: ["read", "grep", "find", "ls", "bash"],
 *       maxTurns: 8,
 *     },
 *     {
 *       name: "coder",
 *       description: "Writes and edits code files",
 *       systemPrompt: "You are a coding assistant. Write clean, well-tested code.",
 *       allowedTools: ["read", "write", "edit", "bash"],
 *       maxTurns: 10,
 *     },
 *   ],
 * });
 *
 * // Add to parent tool set
 * tools.push(subagentTool);
 * ```
 */

export { createSubagentTool } from "./tool.ts";

export {
  defaultProfiles,
  researcherProfile,
  coderProfile,
  reviewerProfile,
} from "./profiles.ts";

export type {
  SubagentArgs,
  SubagentEvent,
  SubagentProfile,
  SubagentToolOptions,
} from "./types.ts";
