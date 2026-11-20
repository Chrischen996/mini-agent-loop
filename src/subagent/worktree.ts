/**
 * Subagent worktree isolation (Grok Build-style task isolation).
 *
 * A subagent requesting `isolation: "worktree"` runs inside a dedicated git
 * worktree so its edits never touch the parent workspace until the branch is
 * merged. Mirrors the goal-worker flow:
 *
 * - New task: create a worktree via `GitWorkflow.createIsolatedBranch`,
 *   labeled `subagent-<taskId>`; creation failures fall back to the shared
 *   workspace instead of hard-failing.
 * - Resume/restart: reuse the persisted worktree when it is still
 *   registered, rehydrate it from its branch when the directory was
 *   removed, and fall back to the shared workspace when neither works
 *   (the previous branch stays mergeable even in that case).
 *
 * The worktree is deliberately preserved after completion (like goal
 * workers) so changes can be reviewed and merged; the task record carries
 * `worktreePath`/`worktreeBranch` for that lifecycle.
 */

import { GitWorkflow, setupIsolatedWorktreeEnvironment } from "../git/workflow.ts";

export type SubagentWorktreeOutcome =
  | { kind: "isolated"; worktreePath: string; worktreeBranch: string }
  | { kind: "shared"; reason: string };

export type ResolveSubagentWorktreeOptions = {
  /** Directory of the owning git repository (usually the parent's project cwd). */
  sourceCwd: string;
  /** Task ID used in the worktree/branch name. */
  taskId: string;
  /** Base directory for worktrees; defaults to `$MINI_AGENT_WORKTREE_DIR` or `~/.mini-agent/worktrees`. */
  worktreeBaseDir?: string;
  /** Persisted worktree from a resumed/restarted task, when present. */
  resume?: { worktreePath?: string; worktreeBranch?: string };
};

/**
 * Resolve the effective execution directory for a worktree-isolated
 * subagent. Never throws: any failure degrades to the shared workspace
 * with a human-readable reason (Grok Build fallback semantics).
 */
export async function resolveSubagentWorktree(
  options: ResolveSubagentWorktreeOptions,
): Promise<SubagentWorktreeOutcome> {
  const workflow = new GitWorkflow(
    options.sourceCwd,
    options.worktreeBaseDir ? { worktreeDir: options.worktreeBaseDir } : undefined,
  );

  if (options.resume?.worktreePath && options.resume.worktreeBranch) {
    try {
      const reused = await reusePersistedWorktree(workflow, options.resume, options.sourceCwd);
      if (reused) return reused;
    } catch {
      // Registration checks can fail (repo gone, locked git index); fall
      // through to the shared workspace instead of failing the task.
    }
    return {
      kind: "shared",
      reason:
        "The previously isolated worktree could not be rehydrated; the sub-agent runs in the shared workspace " +
        `(branch ${options.resume.worktreeBranch} remains mergeable).`,
    };
  }

  try {
    const isolated = await workflow.createIsolatedBranch(`subagent-${options.taskId.slice(0, 24)}`);
    // Best-effort goal-worker parity: link the source checkout's
    // node_modules and copy its .env so the child's tooling works inside
    // the worktree. Never fails the task.
    await setupIsolatedWorktreeEnvironment(options.sourceCwd, isolated.path).catch(() => undefined);
    return { kind: "isolated", worktreePath: isolated.path, worktreeBranch: isolated.branch };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "shared",
      reason: `Worktree isolation requested but unavailable (${message}); the sub-agent runs in the shared workspace.`,
    };
  }
}

/** Reuse or rehydrate a persisted worktree; undefined when neither works. */
async function reusePersistedWorktree(
  workflow: GitWorkflow,
  resume: { worktreePath?: string; worktreeBranch?: string },
  sourceCwd: string,
): Promise<SubagentWorktreeOutcome | undefined> {
  if (!resume.worktreePath || !resume.worktreeBranch) return undefined;
  const registered = await workflow.isRegisteredWorktree(resume.worktreePath);
  if (registered) {
    await setupIsolatedWorktreeEnvironment(sourceCwd, resume.worktreePath).catch(() => undefined);
    return { kind: "isolated", worktreePath: resume.worktreePath, worktreeBranch: resume.worktreeBranch };
  }
  const rehydrated = await workflow.rehydrateWorktree(resume.worktreePath, resume.worktreeBranch);
  if (!rehydrated) return undefined;
  await setupIsolatedWorktreeEnvironment(sourceCwd, resume.worktreePath).catch(() => undefined);
  return { kind: "isolated", worktreePath: resume.worktreePath, worktreeBranch: resume.worktreeBranch };
}

/** Human-readable merge hint appended to isolated-task results. */
export function subagentWorktreeHint(worktreePath: string, worktreeBranch: string): string {
  return `\n\n[worktree] The sub-agent worked in an isolated git worktree at ${worktreePath} on branch ${worktreeBranch}. ` +
    "Its changes do not affect the main workspace until the branch is merged.";
}
