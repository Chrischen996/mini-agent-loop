import { contentAsString } from "../content.ts";
import {
  MaxTurnsExceededError,
  RunStoppedError,
  runAgentTurn,
  type AgentBudgetUsage,
  type AgentRunPolicy,
  type AgentTurnOptions,
  type StopReason,
} from "../loop.ts";
import type { AgentMessage } from "../types.ts";

const POLICY_FIELDS = {
  tokenBudget: "TOKEN_BUDGET",
  toolCallBudget: "TOOL_CALL_BUDGET",
  writeCallBudget: "WRITE_CALL_BUDGET",
  deadlineMs: "DEADLINE_MS",
  maxCompactions: "MAX_COMPACTIONS",
  emergencyIterationCap: "EMERGENCY_ITERATION_CAP",
} as const;

function integer(value: number, name: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

/** TUI defaults to policy execution; an explicit legacy limit opts into a hard stop. */
export function resolveTuiRunOptions(
  options: Pick<AgentTurnOptions, "maxTurns" | "runPolicy"> = {},
  env: NodeJS.ProcessEnv = process.env,
): Pick<AgentTurnOptions, "maxTurns" | "runPolicy"> {
  const envTurns = env.MINI_AGENT_MAX_TURNS;
  const legacyTurns = options.maxTurns ?? (envTurns?.trim() ? Number(envTurns) : undefined);
  if (!options.runPolicy && legacyTurns !== undefined) {
    return { maxTurns: integer(legacyTurns, "maxTurns / MINI_AGENT_MAX_TURNS", 0) };
  }
  const read = (suffix: string, fallback?: number): number | undefined => {
    const name = `MINI_AGENT_TUI_${suffix}`;
    const value = env[name];
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive safe integer`);
    return integer(Number(value), name);
  };
  const policy: AgentRunPolicy = {};
  for (const [field, suffix] of Object.entries(POLICY_FIELDS) as [keyof typeof POLICY_FIELDS, string][]) {
    const fallback = field === "maxCompactions" ? 8 : field === "emergencyIterationCap" ? 2000 : undefined;
    const value = options.runPolicy?.[field] ?? read(suffix, fallback);
    if (value !== undefined) policy[field] = integer(value, `runPolicy.${field}`);
  }
  policy.stallPolicy = {
    sameActionLimit: integer(options.runPolicy?.stallPolicy?.sameActionLimit ?? read("SAME_ACTION_LIMIT", 3)!, "sameActionLimit"),
    noProgressLimit: integer(options.runPolicy?.stallPolicy?.noProgressLimit ?? read("NO_PROGRESS_LIMIT", 6)!, "noProgressLimit"),
  };
  return { runPolicy: policy };
}

export type TuiTurnStop = {
  reason: StopReason | "step_limit";
  details: string;
  budgetUsage?: AgentBudgetUsage;
};

export type TuiAgentTurnResult = { history: AgentMessage[]; stop?: TuiTurnStop };

/** Ink and headless sessions share stop handling and preserve every completed tool result. */
export async function runTuiAgentTurn(
  history: AgentMessage[],
  prompt: string,
  options: AgentTurnOptions,
): Promise<TuiAgentTurnResult> {
  try {
    const next = await runAgentTurn(history, prompt, { ...options, ...resolveTuiRunOptions(options) });
    return { history: next };
  } catch (error) {
    if (error instanceof RunStoppedError) {
      return { history: error.messages, stop: { reason: error.stopReason, details: error.message, budgetUsage: error.budgetUsage } };
    }
    if (error instanceof MaxTurnsExceededError) {
      return { history: error.messages, stop: { reason: "step_limit", details: error.message } };
    }
    throw error;
  }
}

/** Continue reuses the original prompt for routing without adding a synthetic user message. */
export function tuiContinuationPrompt(history: AgentMessage[]): string {
  const user = [...history].reverse().find((message) => message.role === "user");
  if (!user) throw new Error("No task to continue. Submit a prompt first.");
  return contentAsString(user.content);
}
