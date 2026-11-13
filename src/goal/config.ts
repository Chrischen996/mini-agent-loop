import type { Tool } from "../tools/types.ts";
import { GoalManager, type GoalEvent } from "./manager.ts";
import { GoalRuntimeController, type GoalSteeringOptions } from "./runtime.ts";
import { GoalStore } from "./store.ts";
import { createGoalTools } from "./tools.ts";

export type GoalFeatureConfig = {
  enabled: boolean;
  maxGoalTokenBudget?: number;
  maxContinuations?: number;
  dataDir?: string;
};

export type GoalSessionContext = {
  sessionId: string;
  store: GoalStore;
  manager: GoalManager;
  runtime: GoalRuntimeController;
  tools: Tool[];
};

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Goal feature resolution shared by CLI, TUI, and server.
 * Default: ENABLED (setting a goal just works). Opt out explicitly with
 * `MINI_AGENT_GOALS=0|false|no|off`. Steering/auto-continuation only ever
 * activates while an *active* goal exists, so the default-on path is inert.
 */
export function resolveGoalConfig(env: NodeJS.ProcessEnv = process.env): GoalFeatureConfig {
  const raw = (env.MINI_AGENT_GOALS ?? "").trim().toLowerCase();
  const enabled = raw === "" ? true : !["0", "false", "no", "off"].includes(raw);
  return {
    enabled,
    maxGoalTokenBudget: parsePositiveInteger(env.MINI_AGENT_GOAL_MAX_TOKEN_BUDGET),
    maxContinuations: parsePositiveInteger(env.MINI_AGENT_GOAL_MAX_CONTINUATIONS),
    ...(env.AGENT_DATA_DIR ? { dataDir: env.AGENT_DATA_DIR } : {}),
  };
}

export type CreateGoalSessionOptions = GoalFeatureConfig & {
  sessionId: string;
  onEvent?: (event: GoalEvent) => void;
  steering?: GoalSteeringOptions;
  /** Use an existing store (for example shared with a client) instead of creating one. */
  store?: GoalStore;
};

/** Build the per-session goal manager, runtime controller, and model tools. */
export function createGoalSession(options: CreateGoalSessionOptions): GoalSessionContext {
  const store = options.store ?? new GoalStore(options.dataDir ? { dataDir: options.dataDir } : {});
  const manager = new GoalManager({
    store,
    sessionId: options.sessionId,
    ...(options.maxGoalTokenBudget !== undefined ? { maxGoalTokenBudget: options.maxGoalTokenBudget } : {}),
    onEvent: options.onEvent,
  });
  const runtime = new GoalRuntimeController(manager, {
    ...(options.maxContinuations !== undefined ? { maxContinuations: options.maxContinuations } : {}),
    ...options.steering,
  });
  return {
    sessionId: options.sessionId,
    store,
    manager,
    runtime,
    tools: createGoalTools(manager),
  };
}
