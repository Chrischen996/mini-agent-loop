/**
 * Detached background goal runner.
 *
 * `/goal <objective> --bg` registers the goal on the owning session, then this
 * module launches a detached CLI worker that pursues it while the foreground
 * chat stays free. Three safety decisions are baked in (user-approved):
 *
 * 1. **git worktree isolation** — the worker runs in a fresh isolated branch,
 *    never in the live checkout. No worktree (non-git / dirty tree) → refuse
 *    to launch instead of silently writing into the foreground workspace.
 * 2. **bypass permissions** — the worker is unattended, so it runs fully
 *    autonomous inside its worktree. The worktree prevents accidental writes
 *    to the live checkout; it is directory-level isolation, not a sandbox.
 * 3. **foreground mutex** — while a background runner owns the goal, the
 *    foreground loop must not also attach goalRuntime (double steering /
 *    double accounting). Callers check `isBackgroundGoalActive()` with the
 *    registry so a crashed worker cannot strand the mutex.
 *
 * The worker is a regular subagent-registry task, so `subagent_tasks`,
 * `subagent_output`, `subagent_wait`, `subagent_kill`, the Ctrl+B panel and
 * completion auto-wake all work without extra plumbing.
 */
import { randomUUID } from "node:crypto";
import { copyFile, lstat, realpath, rm, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { GitWorkflow } from "../git/workflow.ts";
import { launchDetachedSubagentWorker } from "../subagent/worker-host.ts";
import type { SubagentTaskRegistry, SubagentTaskStatus } from "../subagent/task-registry.ts";
import type { GoalStore } from "./store.ts";
import { isUnfinished, type GoalState } from "./types.ts";

/** Env marker read by the CLI worker entry to bind the goal to the owner session. */
export const GOAL_WORKER_OWNER_ENV = "MINI_AGENT_GOAL_WORKER_OWNER";
/** Env marker carrying the isolated worktree path for the completion report. */
export const GOAL_WORKER_WORKTREE_ENV = "MINI_AGENT_GOAL_WORKER_WORKTREE";
/** Env marker carrying the isolated branch name for the completion report. */
export const GOAL_WORKER_BRANCH_ENV = "MINI_AGENT_GOAL_WORKER_BRANCH";
/** Env marker pointing the worker's task registry at the owner's workspace
 *  (the worker cwd is a worktree, but task records live in the live checkout). */
export const GOAL_WORKER_REGISTRY_ROOT_ENV = "MINI_AGENT_GOAL_WORKER_REGISTRY_ROOT";

export type BackgroundGoalLaunch = {
  taskId: string;
  worktreeDir: string;
  branch: string;
};

/**
 * Global limiter scope for all detached goal workers. The registry only
 * accepts UUID-shaped scope ids, so reuse a stable UUID rather than inventing
 * one per launch.
 */
const GOAL_WORKER_CONCURRENCY_SCOPE = "00000000-0000-4000-8000-000000000001";

export type LaunchBackgroundGoalOptions = {
  /** Live checkout (the git repo the worktree branches from). */
  cwd: string;
  /** Session whose goal store the worker binds to. */
  ownerSessionId: string;
  objective: string;
  registry: SubagentTaskRegistry;
  store: GoalStore;
  /** CLI entry point; defaults to this package's cli.ts (tsx execArgv carries the loader). */
  entryPoint?: string;
  env?: NodeJS.ProcessEnv;
  execArgv?: string[];
  /** Cross-process ceiling for detached goal workers. 0 disables the cap. */
  concurrencyLimit?: number;
  /** Cancels waiting for a concurrency slot; cleanup marks the goal blocked. */
  concurrencySignal?: AbortSignal;
};

/**
 * True when the persisted goal is actively pursued by a detached worker.
 * Foreground loops call this to skip goalRuntime attachment (mutex rule 3).
 * The worker itself never consults it — it is the owner.
 */
const RELEASED_WORKER_STATUSES: readonly SubagentTaskStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

/**
 * Check the persisted goal and, when a registry is supplied, the owning task's
 * liveness. A dead worker must not strand the foreground mutex after a crash.
 */
export async function isBackgroundGoalActive(
  store: GoalStore,
  sessionId: string,
  registry?: SubagentTaskRegistry,
): Promise<boolean> {
  const goal = await store.get(sessionId);
  if (!goal || !isUnfinished(goal) || goal.status !== "active" || !goal.backgroundTaskId) return false;
  if (!registry) return true;
  const record = await registry.get(goal.backgroundTaskId, sessionId).catch(() => undefined);
  if (!record || RELEASED_WORKER_STATUSES.includes(record.status)) {
    await store.update(sessionId, (current) => {
      if (!current || current.backgroundTaskId !== goal.backgroundTaskId) return current;
      const next: GoalState = { ...current, updatedAt: Date.now() };
      delete next.backgroundTaskId;
      return next;
    }).catch(() => undefined);
    return false;
  }
  return true;
}


/**
 * Create the isolated worktree, register the task, and fork the detached
 * worker. Throws with a user-actionable message when isolation is impossible;
 * the caller surfaces it as a Goal notice and leaves the goal unset.
 */
export async function launchBackgroundGoal(options: LaunchBackgroundGoalOptions): Promise<BackgroundGoalLaunch> {
  const workflow = new GitWorkflow(options.cwd);
  let isolated;
  try {
    isolated = await workflow.createIsolatedBranch(`goal-${randomUUID().slice(0, 8)}`);
  } catch (error) {
    throw new Error(
      `Background goals require a clean git repository for worktree isolation: ${error instanceof Error ? error.message : String(error)}. ` +
      "Commit or stash your changes, or run the goal in the foreground (drop --bg).",
    );
  }

  // The subagent registry validates task ids as `sub_<uuid>`; goal tasks ride
  // the same registry so they must use the same shape.
  const taskId = `sub_${randomUUID()}`;
  const now = new Date().toISOString();
  await options.registry.start({
    taskId,
    ownerSessionId: options.ownerSessionId,
    task: options.objective,
    args: { task: options.objective, runInBackground: true },
    status: "queued",
    runInBackground: true,
    createdAt: now,
    startedAt: now,
    runtime: { model: "goal-worker", provider: "cli", baseUrl: "", thinkingMode: "fixed", modelSwitchSucceeded: true },
    killed: false,
    blockWaited: false,
    completionConsumed: false,
    wakeDelivered: false,
  });
  // Persist the runner identity on the goal so any client can detect the
  // mutex and so `/goal status` can name the task.
  await options.store.update(options.ownerSessionId, (current) => {
    if (!current) throw new Error("goal vanished before the background worker started");
    return { ...current, backgroundTaskId: taskId, worktreeDir: isolated.path, worktreeBranch: isolated.branch, updatedAt: Date.now() };
  });

  let env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    MINI_AGENT_SESSION_ID: options.ownerSessionId,
    MINI_AGENT_SUBAGENT_WORKER_TASK_ID: taskId,
    MINI_AGENT_SUBAGENT_WORKER_OWNER_SESSION_ID: options.ownerSessionId,
    MINI_AGENT_SUBAGENT_WORKER_OPTIONS: JSON.stringify({ mode: "bypass", sandboxConfig: null, allowMcpTools: false, mcpAllowlist: [] }),
    [GOAL_WORKER_OWNER_ENV]: options.ownerSessionId,
    [GOAL_WORKER_WORKTREE_ENV]: isolated.path,
    [GOAL_WORKER_BRANCH_ENV]: isolated.branch,
    [GOAL_WORKER_REGISTRY_ROOT_ENV]: options.cwd,
  };
  if (options.concurrencyLimit !== undefined) {
    try {
      await options.registry.acquireGlobalConcurrencySlot(
        GOAL_WORKER_CONCURRENCY_SCOPE,
        taskId,
        options.concurrencyLimit,
        options.concurrencySignal,
      );
    } catch (error) {
      await cleanupFailedLaunch(taskId, options, error);
      throw error;
    }
    env = { ...env, MINI_AGENT_GOAL_WORKER_LIMIT: String(options.concurrencyLimit) };
  }
  await setupWorktreeEnvironment(options.cwd, isolated.path);
  try {
    // fork() with no args re-runs the parent's main module (argv[1]), which
    // for `npm run tui` is process-supervisor.ts, NOT cli.ts. Pass the entry
    // point explicitly so the detached worker always executes the CLI
    // (its isCliEntryPoint guard checks argv[1]).
    await launchDetachedSubagentWorker({
      entryPoint: options.entryPoint ?? fileURLToPath(new URL("../cli.ts", import.meta.url)),
      args: [options.entryPoint ?? fileURLToPath(new URL("../cli.ts", import.meta.url))],
      cwd: isolated.path,
      execArgv: options.execArgv ?? process.execArgv,
      env,
      taskId,
      registry: options.registry,
    });
  } catch (error) {
    await cleanupFailedLaunch(taskId, options, error);
    throw error;
  }
  await options.registry.detach(taskId);
  return { taskId, worktreeDir: isolated.path, branch: isolated.branch };
}

async function cleanupFailedLaunch(
  taskId: string,
  options: LaunchBackgroundGoalOptions,
  error: unknown,
): Promise<void> {
  if (options.concurrencyLimit !== undefined) {
    await options.registry.releaseGlobalConcurrencySlot(GOAL_WORKER_CONCURRENCY_SCOPE, taskId).catch(() => undefined);
  }
  await options.registry.finish(taskId, {
    status: "failed",
    result: "",
    isError: true,
    error: `Could not start goal worker: ${error instanceof Error ? error.message : String(error)}`,
    messages: [],
  }).catch(() => undefined);
  // Release the mutex so the user can retry in the foreground.
  await options.store.update(options.ownerSessionId, (current) => {
    if (!current) return undefined;
    const next: GoalState = { ...current, status: "blocked", updatedAt: Date.now() };
    delete next.backgroundTaskId;
    return next;
  }).catch(() => undefined);
}

async function setupWorktreeEnvironment(sourceCwd: string, worktreeCwd: string): Promise<void> {
  const sourceNodeModules = path.join(sourceCwd, "node_modules");
  const targetNodeModules = path.join(worktreeCwd, "node_modules");
  const sourceStat = await lstat(sourceNodeModules).catch(() => undefined);
  if (sourceStat?.isDirectory() && !sourceStat.isSymbolicLink()) {
    const sourceRealPath = await realpath(sourceNodeModules);
    const worktreeRealPath = await realpath(worktreeCwd);
    const relativePath = path.relative(worktreeRealPath, sourceRealPath);
    if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
      await symlink(relativePath, targetNodeModules, "dir");
    }
  }
  await copyFile(path.join(sourceCwd, ".env"), path.join(worktreeCwd, ".env"))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
}

/** Human-readable launch notice for the TUI/CLI. */
export function backgroundGoalNotice(launch: BackgroundGoalLaunch): string {
  return [
    "Background goal started.",
    `Task: ${launch.taskId} (inspect with subagent_output / subagent_wait, stop with subagent_kill)`,
    `Worktree: ${launch.worktreeDir}`,
    `Branch: ${launch.branch}`,
    "The worker runs with bypass permissions inside the isolated worktree; merge the branch when the goal completes.",
  ].join("\n");
}
