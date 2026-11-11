import type { Tool, ToolResult } from "../tools/types.ts";
import type { GoalManager } from "./manager.ts";
import { goalSnapshot, type GoalSnapshot } from "./types.ts";

export const GET_GOAL_TOOL_NAME = "get_goal";
export const CREATE_GOAL_TOOL_NAME = "create_goal";
export const UPDATE_GOAL_TOOL_NAME = "update_goal";

function result(value: unknown, isError = false): ToolResult {
  return { content: JSON.stringify(value), ...(isError ? { isError: true } : {}) };
}

function failure(message: string): ToolResult {
  return result({ error: message }, true);
}

function snapshotResponse(goal: GoalSnapshot | undefined, completionBudgetReport?: string) {
  return {
    goal: goal ?? null,
    remainingTokens: goal?.remainingTokens ?? null,
    ...(completionBudgetReport ? { completionBudgetReport } : {}),
  };
}

/** Session-scoped goal tools. All failures become isError tool results, never loop crashes. */
export function createGoalTools(manager: GoalManager): Tool[] {
  const getTool: Tool = {
    name: GET_GOAL_TOOL_NAME,
    description: "Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.",
    source: { kind: "local" },
    annotations: { readOnlyHint: true, idempotentHint: true },
    capabilities: {
      readWorkspace: false, writeWorkspace: false, executeProcess: false,
      network: false, externalData: false, destructive: false, requiresApproval: false,
    },
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(): Promise<ToolResult> {
      try {
        const goal = await manager.get();
        return result(snapshotResponse(goal ? goalSnapshot(goal.raw) : undefined));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const createTool: Tool = {
    name: CREATE_GOAL_TOOL_NAME,
    description: "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.\nSet token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; use update_goal only for status.",
    source: { kind: "local" },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    capabilities: {
      readWorkspace: false, writeWorkspace: false, executeProcess: false,
      network: false, externalData: false, destructive: false, requiresApproval: false,
    },
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        objective: {
          type: "string",
          description: "Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete.",
        },
        token_budget: {
          type: "integer",
          minimum: 1,
          description: "Positive token budget for the new goal. Omit unless explicitly requested.",
        },
      },
      required: ["objective"],
    },
    async execute(args): Promise<ToolResult> {
      try {
        const goal = await manager.createFromModel(
          args.objective as string,
          args.token_budget as number | undefined,
        );
        return result(snapshotResponse(goalSnapshot(goal)));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const updateTool: Tool = {
    name: UPDATE_GOAL_TOOL_NAME,
    description: "Update the existing goal.\nSet status to `paused` only at the user's explicit request to pause this goal, never on your own initiative. Ask if unclear; a later resume revokes that request. Report the returned status and stop goal work. Budget limits take precedence over pausing.\nSet status to `complete` only when the objective has actually been achieved and no required work remains.\nSet status to `blocked` only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic continuations, and the agent cannot make meaningful progress without user input or an external-state change.\nIf the user resumes a goal that was previously marked `blocked`, treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least three consecutive resumed goal turns, set status to `blocked` again.\nOnce the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to `blocked`.\nDo not use `blocked` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.\nDo not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.\nYou cannot use this tool to resume, budget-limit, or usage-limit a goal; those status changes are controlled by the user or system.\nWhen marking a budgeted goal achieved with status `complete`, report the final token usage from the tool result to the user.",
    source: { kind: "local" },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    capabilities: {
      readWorkspace: false, writeWorkspace: false, executeProcess: false,
      network: false, externalData: false, destructive: false, requiresApproval: false,
    },
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["complete", "blocked", "paused"],
          description: "Required. `paused` requires an explicit user request. Set to `complete` only when the objective is achieved and no required work remains. Set to `blocked` only after the same blocking condition has recurred for at least three consecutive goal turns and the agent is at an impasse. After a previously blocked goal is resumed, the resumed run starts a fresh blocked audit.",
        },
      },
      required: ["status"],
    },
    async execute(args): Promise<ToolResult> {
      try {
        const outcome = await manager.updateFromModel(args.status as string);
        if (outcome.rejected) return failure(outcome.message);
        const report = outcome.goal?.status === "complete" && outcome.goal.tokenBudget !== undefined
          ? "Goal achieved. Report final usage from this tool result's structured goal fields: tokensUsed and tokenBudget."
          : undefined;
        return result(snapshotResponse(outcome.goal ? goalSnapshot(outcome.goal) : undefined, report));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };

  return [getTool, createTool, updateTool];
}
