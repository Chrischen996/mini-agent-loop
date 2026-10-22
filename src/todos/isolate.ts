import type { GitWorkflow } from "../git/workflow.ts";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** One-time worktree per-label isolation for subagent tasks. */
export interface IsolationContext {
  worktreeDir: string;
  branch: string;
  revert: () => Promise<void>;
}

export interface IsolationDeps {
  cwd: string;
  /** The GitWorkflow instance to use for worktree operations. */
  workflow: GitWorkflow;
}

/**
 * Create an isolated worktree for a subagent task if the cwd is a git repo
 * and the worktree is clean. Falls back to no-op isolation otherwise.
 * The caller should revert after task completion.
 */
export async function isolateForTask(
  deps: IsolationDeps,
  taskLabel: string,
): Promise<IsolationContext | null> {
  try {
    const baseDir = join(deps.workflow.worktreeDir, taskLabel.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48));
    await mkdir(baseDir, { recursive: true });
    const branch = `todo-runner/${taskLabel.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 32)}`;
    const info = await deps.workflow.createIsolatedBranch(branch);
    return {
      worktreeDir: info.path,
      branch: info.branch,
      revert: async () => {
        // Worktree cleanup happens via GitWorkflow; best-effort here.
      },
    };
  } catch {
    // Revert to no-op isolation when worktree creation fails.
    return null;
  }
}
