/**
 * Append-only JSONL diagnostic log for goal-driven runs.
 *
 * Purpose: answer "why did /goal not behave as expected" *after* the run, by
 * capturing the two things a goal snapshot alone cannot show — whether steering
 * actually reached the model, and why automatic continuations stopped.
 *
 * Constraints: opt-in (`MINI_AGENT_GOAL_LOG=1`), never throws, appends small
 * lines synchronously so ordering matches real events and nothing is lost if
 * the process dies mid-turn.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { getDataRoot } from "../session-store.ts";
import { goalSnapshot, type GoalSnapshot } from "./types.ts";
import type { GoalRuntimeController } from "./runtime.ts";
import type { AgentMessage } from "../types.ts";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

/** `MINI_AGENT_GOAL_LOG=1` enables logging; `..._LOG_PATH` overrides the file. */
export function isGoalLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUE_VALUES.has((env.MINI_AGENT_GOAL_LOG ?? "").trim().toLowerCase());
}

export function resolveGoalLogPath(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.MINI_AGENT_GOAL_LOG_PATH;
  if (override) return path.resolve(override);
  // Session ids are UUIDs, but a caller could pass anything; keep it filename-safe.
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "unknown";
  return path.join(getDataRoot(env), "goal-logs", `${safeId}.jsonl`);
}

export type GoalLogEntry = {
  ts: number;
  iso: string;
  sessionId: string;
  event: string;
  goal?: {
    status: string;
    tokensUsed: number;
    tokenBudget?: number;
    remainingTokens?: number;
    timeUsedSeconds: number;
    objective: string;
  };
  [key: string]: unknown;
};

export type GoalLog = {
  readonly path: string;
  log(entry: Omit<GoalLogEntry, "ts" | "iso" | "sessionId">): void;
};

export function compactGoal(goal: GoalSnapshot | null | undefined): GoalLogEntry["goal"] | undefined {
  if (!goal) return undefined;
  return {
    status: goal.status,
    tokensUsed: goal.tokensUsed,
    ...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
    ...(goal.remainingTokens !== undefined ? { remainingTokens: goal.remainingTokens } : {}),
    timeUsedSeconds: goal.timeUsedSeconds,
    // Objectives run up to 4000 chars; keep the log scannable.
    objective: goal.objective.length > 200 ? `${goal.objective.slice(0, 200)}…` : goal.objective,
  };
}

/** Build a logger for one session; `undefined` when disabled (`log?.log(...)`). */
export function createGoalLog(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): GoalLog | undefined {
  if (!isGoalLogEnabled(env)) return undefined;
  const logPath = resolveGoalLogPath(sessionId, env);
  let broken = false;
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
  } catch {
    broken = true;
  }
  const log: GoalLog = {
    path: logPath,
    log(entry) {
      if (broken) return;
      const now = Date.now();
      const full = { ts: now, iso: new Date(now).toISOString(), sessionId, ...entry } as GoalLogEntry;
      try {
        appendFileSync(logPath, `${JSON.stringify(full)}\n`, "utf8");
      } catch {
        // One failure is enough: stop trying rather than spamming per event.
        broken = true;
      }
    },
  };
  log.log({ event: "log_opened", pid: process.pid });
  return log;
}

/** Wrap an existing callback so the original behavior is preserved verbatim. */
function tap<T>(original: ((value: T) => void) | undefined, side: (value: T) => void): (value: T) => void {
  return (value: T) => {
    side(value);
    original?.(value);
  };
}

export type GoalUpdatedEvent = { type: "goal_updated"; goal: GoalSnapshot | null; reason: string };

export type GoalDiagnosticOptions = {
  log?: GoalLog;
  /** Existing manager event callback (TUI state update). Preserved. */
  onEvent?: (event: GoalUpdatedEvent) => void;
  onGoalSnapshot?: (goal: GoalSnapshot | null) => void;
  onBudgetLimited?: (goal: { status: string }) => void;
};

/**
 * Label the steering prompt family by its exact opening sentence.
 *
 * Matching on keywords is wrong here: *every* steering prompt contains a
 * "Budget:" section, so a `/budget/` test mislabels ordinary continuations as
 * budget-limit events. Each builder in `steering.ts` starts with a unique line,
 * so anchor on that instead.
 */
const STEERING_SIGNATURES: ReadonlyArray<readonly [string, string]> = [
  ["A goal was created for this thread.", "goal_created"],
  ["The active thread goal objective was edited by the user.", "objective_updated"],
  ["The active thread goal has reached its token budget.", "budget_limit"],
  ["Continue working toward the active thread goal.", "continuation"],
];

export function classifySteering(text: string | undefined): string {
  if (!text) return "unknown";
  for (const [signature, kind] of STEERING_SIGNATURES) {
    if (text.includes(signature)) return kind;
  }
  return "unknown";
}

/**
 * Attach diagnostics to an already-built goal session and wire the tapped
 * callbacks back into it.
 *
 * The interesting signals are not in the manager's event stream:
 * - `prepareMessages()` is the single choke point every steering branch passes
 *   through, so comparing message counts before/after reveals *which* steering
 *   text was injected (or that none was).
 * - `shouldContinue()` is the single continuation decision point; logging its
 *   result distinguishes "goal left active" from "continuation cap reached".
 *
 * `runtime.onGoalEvent` is deliberately NOT tapped: `loop.ts` reassigns it every
 * turn, so a hook installed there would be silently dropped. Manager events are
 * captured through `setEventSink` instead, which survives that reassignment.
 *
 * Idempotent: calling it twice on the same runtime does not double-wrap.
 */
export function attachGoalDiagnostics(
  session: { manager: { setEventSink(sink: ((event: GoalUpdatedEvent) => void) | undefined): void }; runtime: GoalRuntimeController },
  options: GoalDiagnosticOptions,
): void {
  const { log } = options;

  const onEvent = tap(options.onEvent, (event: GoalUpdatedEvent) => {
    log?.log({ event: "goal_updated", reason: event.reason, goal: compactGoal(event.goal) });
  });
  const onGoalSnapshot = tap(options.onGoalSnapshot, (goal: GoalSnapshot | null) => {
    // Usage ticks arrive only through this callback, so it is the sole place
    // token accounting is observable.
    log?.log({ event: "goal_snapshot", goal: compactGoal(goal) });
  });
  const onBudgetLimited = tap(options.onBudgetLimited, (goal: { status: string }) => {
    log?.log({ event: "budget_limited_steering", status: goal.status });
  });

  session.manager.setEventSink(onEvent);
  const runtime = session.runtime;
  runtime.setSteeringSinks({ onGoalSnapshot, onBudgetLimited });

  if (!log || instrumentedRuntimes.has(runtime)) return;
  instrumentedRuntimes.add(runtime);

  const originalPrepare = runtime.prepareMessages.bind(runtime);
  runtime.prepareMessages = async (messages: AgentMessage[]) => {
    const before = messages.length;
    const result = await originalPrepare(messages);
    const injected = result.length > before;
    const tail = injected ? result[result.length - 1] : undefined;
    const text = tail && typeof tail.content === "string" ? tail.content : undefined;
    log.log({
      event: "steering_prepare",
      messagesBefore: before,
      messagesAfter: result.length,
      injected,
      steeringKind: injected ? classifySteering(text) : "none",
      steeringPreview: text ? text.replace(/\s+/g, " ").slice(0, 160) : undefined,
    });
    return result;
  };

  const originalContinue = runtime.shouldContinue.bind(runtime);
  runtime.shouldContinue = async () => {
    const decision = await originalContinue();
    log.log({
      event: "continuation_decision",
      continued: Boolean(decision),
      isContinuation: decision?.isContinuation ?? false,
      goal: decision ? compactGoal(goalSnapshot(decision.goal)) : undefined,
      stopReason: decision ? undefined : "goal_not_active_or_continuation_cap",
    });
    return decision;
  };

  const originalFinish = runtime.finish.bind(runtime);
  runtime.finish = async () => {
    await originalFinish();
    log.log({ event: "turn_finished" });
  };
}

/** Runtimes already wrapped, so repeated attachment cannot stack wrappers. */
const instrumentedRuntimes = new WeakSet<object>();
