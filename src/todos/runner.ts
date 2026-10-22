import type { RunnerPlan, RunnerTask } from "./types.ts";
import type { BgExecutor, BgCommandDetector, BgPoller, SubagentExecutor } from "./execute.ts";
import { planRunnerTask } from "./execute.ts";
import { lockFor } from "./classify.ts";

export interface RunnerOutcome {
  taskId: string;
  ok: boolean;
  summary?: string;
  error?: string;
  bgTaskId?: string;
}

export interface RunTodoPlanOptions {
  /** Max concurrency for unlocked subagent batches (defaults to task count). */
  maxConcurrency?: number;
  /** Subagent execution strategy (used for code/docs/unknown tasks). */
  subagent: SubagentExecutor;
  /** Launch a background task for bg-runner tasks; resolves to its id. */
  startBgTask: BgExecutor;
  /** Poll a background task; resolves when it reaches a terminal state. */
  pollBgTask: BgPoller;
  /** Optional detector that overrides the default bg command per task. */
  bgCommandDetector?: BgCommandDetector;
  /** Abort the whole run. */
  signal?: AbortSignal;
  /** Progress callback fired on every task transition. */
  onEvent?: (event: { taskId: string; status: RunnerTask["status"]; error?: string }) => void;
}

type AsyncLock = {
  run: <T>(body: () => Promise<T>) => Promise<T>;
};

/** Tiny promise-chained mutex — no external dependencies. */
function createAsyncLock(): AsyncLock {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    run(body) {
      const started = chain.then(body, body);
      chain = started.catch(() => undefined);
      return started;
    },
  };
}

/**
 * Execute a RunnerPlan batch by batch, honoring:
 * - maxConcurrency for unlocked (subagent) tasks,
 * - per-lock serialization: locked tasks run solo, and same-lock tasks wait
 *   on a shared AsyncLock so they never interleave,
 * - failure propagation: a failed/blocked dependency blocks its dependents.
 */
export type RunnerJob = {
  id: string;
  startedAt: string;
  plan: RunnerPlan;
};

export async function runTodoPlan(plan: RunnerPlan, options: RunTodoPlanOptions): Promise<RunnerOutcome[]> {
  const { subagent, startBgTask, pollBgTask, bgCommandDetector, signal, onEvent } = options;
  const outcomes = new Map<string, RunnerOutcome>();
  const tasks = new Map<string, RunnerTask>(plan.tasks.map((task) => [task.todoId, task]));
  const locks = new Map<string, AsyncLock>();
  const concurrency = Math.max(1, options.maxConcurrency ?? plan.tasks.length);

  const lockForTask = (task: RunnerTask): AsyncLock | null => {
    const key = lockFor(task.resourceClass);
    if (!key) return null;
    const existing = locks.get(key);
    if (existing) return existing;
    const created = createAsyncLock();
    locks.set(key, created);
    return created;
  };

  for (const batch of plan.batches) {
    if (signal?.aborted) break;

    const isLockedTask = (task: RunnerTask): boolean => lockFor(task.resourceClass) !== null;
    const runnable = batch
      .map((id) => tasks.get(id))
      .filter((task): task is RunnerTask => {
        if (!task) return false;
        const blocked = task.dependsOn.some((depId) => outcomes.get(depId)?.ok !== true);
        if (blocked) {
          task.status = "blocked";
          task.error = `blocked: dependency ${task.dependsOn.filter((dep) => !outcomes.get(dep)?.ok).join(", ")} did not complete`;
          onEvent?.({ taskId: task.todoId, status: "blocked", error: task.error });
          return false;
        }
        return true;
      });

    if (runnable.length === 0) continue;

    // Locked tasks run solo, in order, each holding its lock. Unlocked
    // tasks may run concurrently up to `concurrency`.
    const hasLocked = runnable.some(isLockedTask);
    if (hasLocked) {
      for (const task of runnable) {
        const taskLock = lockForTask(task);
        if (signal?.aborted) break;
        const body = async () => {
          const outcome = await executeTask(task, options);
          outcomes.set(task.todoId, outcome);
          task.status = outcome.ok ? "completed" : "failed";
          task.error = outcome.error;
          task.finishedAt = new Date().toISOString();
          onEvent?.({ taskId: task.todoId, status: task.status, error: task.error });
        };
        if (taskLock) await taskLock.run(body);
        else await body();
      }
    } else {
      // Simple bounded concurrency for unlocked batches.
      const queue = [...runnable];
      const active: Promise<void>[] = [];
      const worker = async () => {
        while (queue.length > 0 && !signal?.aborted) {
          const task = queue.shift();
          if (!task) break;
          const outcome = await executeTask(task, options);
          outcomes.set(task.todoId, outcome);
          task.status = outcome.ok ? "completed" : "failed";
          task.error = outcome.error;
          task.finishedAt = new Date().toISOString();
          onEvent?.({ taskId: task.todoId, status: task.status, error: task.error });
        }
      };
      for (let i = 0; i < Math.min(concurrency, runnable.length); i += 1) active.push(worker());
      await Promise.all(active);
    }
  }

  return plan.tasks.map((task) => {
    const recorded = outcomes.get(task.todoId);
    if (recorded) return recorded;
    // Task was blocked upstream or the run was aborted.
    const outcome: RunnerOutcome = {
      taskId: task.todoId,
      ok: false,
      error: task.error ?? "run aborted before this task started",
    };
    outcomes.set(task.todoId, outcome);
    return outcome;
  });
}

async function executeTask(task: RunnerTask, options: RunTodoPlanOptions): Promise<RunnerOutcome> {
  const spec = planRunnerTask(task, options.bgCommandDetector);
  task.status = "running";
  task.startedAt = new Date().toISOString();
  options.onEvent?.({ taskId: task.todoId, status: "running" });

  if (spec.kind === "bg") {
    try {
      const bgTaskId = await options.startBgTask(spec);
      task.bgTaskId = bgTaskId;
      const polled = await options.pollBgTask(bgTaskId);
      return {
        taskId: task.todoId,
        ok: polled.ok,
        summary: polled.summary,
        error: polled.error,
        bgTaskId,
      };
    } catch (error) {
      return {
        taskId: task.todoId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  try {
    const result = await options.subagent(spec, options.signal);
    return {
      taskId: task.todoId,
      ok: result.ok,
      summary: result.summary,
      error: result.error,
    };
  } catch (error) {
    return {
      taskId: task.todoId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Convenience: run a plan with a live BgTaskManager and the subagent tool.
 * Used by the TUI; tests use `runTodoPlan` directly with mocks.
 */
export function bgExecutorsFor(managerLike: {
  start: (input: { command: string; timeoutSeconds?: number; tags?: string[] }) => Promise<{ taskId: string }>;
  get: (taskId: string) => Promise<{ status: string; exitCode?: number | null; reason?: string } | undefined>;
  wait?: (taskIds: string[], mode?: "any" | "all", timeoutSeconds?: number) => Promise<unknown>;
}, pollIntervalMs = 500): { startBgTask: BgExecutor; pollBgTask: BgPoller } {
  const startBgTask: BgExecutor = async (spec) => {
    const started = await managerLike.start({
      command: spec.command,
      ...(spec.timeoutSeconds !== undefined ? { timeoutSeconds: spec.timeoutSeconds } : {}),
      ...(spec.tags ? { tags: spec.tags } : {}),
    });
    return started.taskId;
  };
  const pollBgTask: BgPoller = async (taskId) => {
    for (;;) {
      const summary = await managerLike.get(taskId);
      if (!summary) return { ok: false, done: true, error: `background task ${taskId} not found` };
      const terminal = !["starting", "running", "unknown"].includes(summary.status);
      if (terminal) {
        const ok = summary.status === "completed" && (summary.exitCode ?? 0) === 0;
        return {
          ok,
          done: true,
          summary: summary.status,
          error: ok ? undefined : summary.reason ?? `background task ended with status ${summary.status}`,
        };
      }
      if (managerLike.wait && managerLike.get === undefined) break; // unreachable, keep control flow simple
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return { ok: false, done: true, error: "background task poller exited without a terminal state" };
  };
  return { startBgTask, pollBgTask };
}

export { planRunnerTask, subagentPromptFor, defaultBgCommand } from "./execute.ts";
export type { BgExecutor, BgCommandDetector, BgPoller, SubagentExecutor } from "./execute.ts";
