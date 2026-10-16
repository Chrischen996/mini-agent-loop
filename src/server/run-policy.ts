import type { AgentRunPolicy } from "../loop.ts";
import type { WebRunState } from "../session-store.ts";

const ENV_FIELDS = {
  tokenBudget: "MINI_AGENT_WEB_TOKEN_BUDGET",
  toolCallBudget: "MINI_AGENT_WEB_TOOL_CALL_BUDGET",
  writeCallBudget: "MINI_AGENT_WEB_WRITE_CALL_BUDGET",
  deadlineMs: "MINI_AGENT_WEB_DEADLINE_MS",
  maxCompactions: "MINI_AGENT_WEB_MAX_COMPACTIONS",
  emergencyIterationCap: "MINI_AGENT_WEB_EMERGENCY_ITERATION_CAP",
} as const;
const BUDGET_FIELDS = ["tokenBudget", "toolCallBudget", "writeCallBudget", "deadlineMs"] as const;

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

export function loadDefaultWebRunPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): AgentRunPolicy {
  const result: AgentRunPolicy = {
    maxCompactions: 8,
    emergencyIterationCap: 2000,
    stallPolicy: { sameActionLimit: 3, noProgressLimit: 6 },
  };
  const read = (name: string): number | undefined => {
    const value = env[name];
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive safe integer`);
    return positiveInteger(Number(value), name);
  };
  for (const [field, name] of Object.entries(ENV_FIELDS)) {
    const value = read(name);
    if (value !== undefined) result[field as keyof typeof ENV_FIELDS] = value;
  }
  result.stallPolicy = {
    sameActionLimit: read("MINI_AGENT_WEB_SAME_ACTION_LIMIT") ?? 3,
    noProgressLimit: read("MINI_AGENT_WEB_NO_PROGRESS_LIMIT") ?? 6,
  };
  return result;
}

/** Programmatic fields override environment fields, which override defaults. */
export function resolveWebRunPolicy(overrides?: AgentRunPolicy, env: NodeJS.ProcessEnv = process.env): AgentRunPolicy {
  const defaults = loadDefaultWebRunPolicyFromEnv(env);
  const defined = <T extends object>(value?: T): Partial<T> => Object.fromEntries(
    Object.entries(value ?? {}).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
  const result = { ...defaults, ...defined(overrides), stallPolicy: { ...defaults.stallPolicy, ...defined(overrides?.stallPolicy) } };
  for (const field of Object.keys(ENV_FIELDS) as (keyof typeof ENV_FIELDS)[]) {
    if (result[field] !== undefined) positiveInteger(result[field], `runPolicy.${field}`);
  }
  for (const [field, value] of Object.entries(result.stallPolicy)) {
    positiveInteger(value, `runPolicy.stallPolicy.${field}`);
  }
  return result;
}

export type ContinueBudgetMode = "new" | "remaining";
export type ContinueRunRequest = Pick<AgentRunPolicy, typeof BUDGET_FIELDS[number]> & {
  /** Default: new allocation. Remaining reuses the saved allocation and its usage. */
  budgetMode?: ContinueBudgetMode;
};

export function resolveContinueRun(
  body: unknown,
  defaultPolicy: AgentRunPolicy | undefined,
  previousState?: WebRunState | null,
): { budgetMode: ContinueBudgetMode; runPolicy?: AgentRunPolicy } {
  const input = body ?? {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("Continue body must be an object");
  const request = input as Record<string, unknown>;
  for (const field of Object.keys(request)) {
    if (field !== "budgetMode" && !BUDGET_FIELDS.includes(field as typeof BUDGET_FIELDS[number])) {
      throw new Error(`Unknown Continue field: ${field}`);
    }
  }
  const budgetMode = request.budgetMode ?? "new";
  if (budgetMode !== "new" && budgetMode !== "remaining") throw new Error("budgetMode must be new or remaining");
  const overrides: AgentRunPolicy = {};
  for (const field of BUDGET_FIELDS) {
    if (request[field] !== undefined) overrides[field] = positiveInteger(request[field], field);
  }
  if (budgetMode === "remaining") {
    if (Object.keys(overrides).length) throw new Error("Remaining budget cannot include new limits; use budgetMode: new");
    if (!previousState?.budgetPolicy || !previousState.budgetUsage) throw new Error("No saved policy budget to resume");
    return { budgetMode, runPolicy: previousState.budgetPolicy };
  }
  // An explicit budget opts a legacy maxTurns session into policy execution for this run.
  const usePolicy = defaultPolicy !== undefined || Object.keys(overrides).length > 0;
  return { budgetMode, runPolicy: usePolicy ? { ...(defaultPolicy ?? resolveWebRunPolicy()), ...overrides } : undefined };
}
