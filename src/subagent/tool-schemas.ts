/**
 * JSON parameter schemas for the `subagent` and `subagent_batch` tools, split
 * out of `src/subagent/tool.ts` (whose `createSubagentTool` /
 * `createSubagentBatchTool` factories inlined two ~90-line schema objects).
 *
 * These are pure data builders: the only inputs are the profile-derived enum
 * and description plus the loop's default-turns constant, so they carry no
 * closure over the runtime and can be read/changed in isolation. `tool.ts`
 * calls them to keep the factory bodies focused on execution logic.
 */

import type { JsonSchema } from "../tools/types.ts";

/** The small set of values the parameter schemas render into the tool docs. */
export type SubagentSchemaContext = {
  /** Profile names, or `undefined` when no profiles are configured. */
  profileEnum?: string[];
  /**
   * Human-readable summary of the available profiles. Only the single-tool
   * schema surfaces it (in the `profile` field description); the batch tool
   * does not need it, so it is optional.
   */
  profileDescription?: string;
  /**
   * The loop default `maxTurns`, surfaced in the `maxTurns` description.
   * Only the single-tool schema uses it; optional for the batch tool.
   */
  defaultMaxTurns?: number;
};

/** Parameter schema for the single `subagent` tool. */
export function buildSubagentParameters(ctx: SubagentSchemaContext): JsonSchema {
  const { profileEnum, profileDescription, defaultMaxTurns } = ctx;
  const defaultTurns = defaultMaxTurns ?? 8;
  return {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "The task description / prompt for the sub-agent.",
      },
      runInBackground: {
        type: "boolean",
        description: "Return immediately with a task ID. Defaults to true when background task management is available.",
      },
      resumeFrom: {
        type: "string",
        description: "Continue a completed sub-agent transcript. The task prompt is appended to its prior conversation and the same task ID is retained.",
      },
      ...(profileEnum
        ? {
            profile: {
              type: "string",
              description: `Name of a pre-defined sub-agent profile. ${profileDescription ?? ""}`,
              enum: profileEnum,
            },
          }
        : {}),
      systemPrompt: {
        type: "string",
        description:
          "Custom system prompt for the sub-agent (ignored when a profile is used).",
      },
      tools: {
        type: "array",
        items: { type: "string" },
        description:
          "List of tool names the sub-agent may use. Omit to inherit all parent tools (except subagent itself).",
      },
      maxTurns: {
        type: "integer",
        minimum: 1,
        description: `Maximum turns for the sub-agent loop. Default: ${defaultTurns}.`,
      },
      model: {
        type: "string",
        description:
          "Model identifier for this sub-agent (e.g. 'openai/gpt-4o-mini'). Overrides profile and parent model.",
      },
      sharedContext: {
        type: "string",
        description:
          "Background context from the parent agent. Prepended to the sub-agent's system prompt.",
      },
      thinkingMode: {
        type: "string",
        enum: ["fixed", "adaptive"],
        description:
          "Thinking mode for the sub-agent loop. 'adaptive' enables explainable effort escalation after tool failures.",
      },
      maxThinkingEscalations: {
        type: "integer",
        minimum: 0,
        description:
          "Maximum adaptive effort increases after tool or validation failures. Default: 2.",
      },
      contextPolicy: {
        type: "object",
        description:
          "Optional context compaction policy (same shape as parent loop's context option).",
      },
      skillNames: {
        type: "array",
        items: { type: "string" },
        description:
          "Skill names to activate for this sub-agent loop.",
      },
      inheritContextHistory: {
        type: "boolean",
        description: "Whether to include the parent agent's current message history.",
      },
      tokenBudget: {
        type: "integer",
        minimum: 1,
        description: "Maximum token budget for this sub-agent loop.",
      },
      isolation: {
        type: "string",
        enum: ["none", "worktree"],
        description:
          "Filesystem isolation for this sub-agent. \"none\" (default) shares the parent workspace; \"worktree\" runs the sub-agent in a dedicated git worktree so its edits do not touch the parent workspace until the branch is merged. Ignored when resuming a task that had no worktree; creation failures fall back to the shared workspace.",
      },
    },
    required: ["task"],
    additionalProperties: false,
  };
}

/** Parameter schema for the `subagent_batch` tool. */
export function buildSubagentBatchParameters(ctx: SubagentSchemaContext): JsonSchema {
  const { profileEnum } = ctx;
  return {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["sync", "async"], description: "Use async to submit a background DAG job and return immediately; sync waits for results." },
      action: { type: "string", enum: ["submit", "status", "result", "wait"], description: "Async job action. Defaults to submit in async mode." },
      jobId: { type: "string", description: "Existing async job identifier for status/result/wait." },
      waitTimeoutMs: { type: "integer", minimum: 0, description: "Maximum time to wait for completion; defaults to 30000ms." },
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Unique label for this task." },
            dependsOn: { type: "array", items: { type: "string" }, description: "Task labels that must succeed before this task starts." },
            task: { type: "string", description: "Task prompt for the sub-agent." },
            ...(profileEnum
              ? { profile: { type: "string", enum: profileEnum, description: "Profile to use." } }
              : {}),
            model: { type: "string", description: "Optional model override." },
            maxTurns: { type: "integer", minimum: 1, description: "Max turns override." },
            sharedContext: { type: "string", description: "Shared context for this task." },
            thinkingMode: {
              type: "string",
              enum: ["fixed", "adaptive"],
              description: "Thinking mode override.",
            },
            maxThinkingEscalations: {
              type: "integer",
              minimum: 0,
              description: "Max adaptive escalations override.",
            },
            contextPolicy: {
              type: "object",
              description: "Context compaction policy override.",
            },
            skillNames: {
              type: "array",
              items: { type: "string" },
              description: "Skill names override.",
            },
            inheritContextHistory: {
              type: "boolean",
              description: "Whether to include the parent's current message history.",
            },
            isolation: {
              type: "string",
              enum: ["none", "worktree"],
              description: "Filesystem isolation for this task. \"worktree\" runs it in a dedicated git worktree; defaults to the shared workspace.",
            },
            tokenBudget: {
              type: "integer",
              minimum: 1,
              description: "Token budget limit for this task.",
            },
          },
          required: ["label", "task"],
        },
        description: "Array of tasks to run in parallel.",
        minItems: 1,
        maxItems: 10,
      },
      maxConcurrency: {
        type: "integer",
        minimum: 0,
        description: "Maximum concurrent sub-agents. 0 or omitted means all run concurrently.",
      },
      budgetAllocation: {
        type: "object",
        description:
          "Optional strategy for allocating the remaining global token budget across batch tasks.",
        properties: {
          strategy: {
            type: "string",
            enum: ["equal", "priority", "dynamic"],
            description:
              "Allocation strategy. equal/dynamic split remaining budget evenly; priority reserves explicit task.tokenBudget first.",
          },
          perTaskLimit: {
            type: "integer",
            minimum: 1,
            description: "Hard ceiling applied to each task after strategy allocation.",
          },
        },
        required: ["strategy"],
        additionalProperties: false,
      },
    },
    required: [],
    additionalProperties: false,
  };
}
