/**
 * Subagent worktree GC (Grok Build-style reclamation).
 *
 * Worktrees are kept after completion so results can be reviewed and merged
 * (goal-worker parity). This module reclaims the directories of finished
 * tasks after a retention window so `~/.mini-agent/worktrees` does not grow
 * unbounded:
 *
 * - Only terminal, unmerged, non-active records are candidates; active tasks
 *   and branches already merged into the live checkout are skipped.
 * - Pending edits are committed into the branch first (snapshot commit).
 * - The branch is pinned to a durable ref (`refs/mini-agent/subagents/<id>`)
 *   before the directory is removed, so the work stays recoverable and the
 *   record can still rehydrate the worktree for a later resume.
 * - Reclamation failures leave the worktree in place; GC is best-effort and
 *   never fails the caller.
 */

import { GitWorkflow } from "../git/workflow.ts";
import type { SubagentTaskRegistry } from "./task-registry.ts";
import { stat } from "node:fs/promises";

export type SubagentWorktreeGcResult = {
  /** Total worktree-isolated records considered. */
  considered: number;
  /** Worktrees reclaimed (directory removed, branch pinned to a snapshot ref). */
  reclaimed: number;
  /** Candidates skipped because they are still active or already merged. */
  skipped: number;
  /** Reclamation attempts that failed (worktree kept in place). */
  failed: number;
  /** Worktrees that would be reclaimed in dry-run mode (== reclaimed otherwise). */
  wouldReclaim?: number;
};

export type GcSubagentWorktreesOptions = {
  /** Registry root (workspace) whose `.subagent-tasks` records are scanned. */
  sourceCwd: string;
  /** Registry instance; required so reclamation is recorded on each task. */
  registry: SubagentTaskRegistry;
  /** Retention window for finished tasks. Default: 7 days. */
  retentionMs?: number;
  /** Only reclaim worktrees that live under this directory. */
  worktreeBaseDir?: string;
  /** Report what would be reclaimed without touching any worktree. */
  dryRun?: boolean;
};

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export async function gcSubagentWorktrees(options: GcSubagentWorktreesOptions): Promise<SubagentWorktreeGcResult> {
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const records = await options.registry.listAllWorktreeRecords();
  const result: SubagentWorktreeGcResult = {
    considered: records.length,
    reclaimed: 0,
    skipped: 0,
    failed: 0,
    ...(options.dryRun ? { wouldReclaim: 0 } : {}),
  };
  const now = Date.now();
  for (const record of records) {
    if (!record.worktreePath || !record.worktreeBranch) continue;
    const active = record.status === "queued" || record.status === "running";
    if (active || record.worktreeMerged || record.endedAt === undefined) {
      result.skipped += 1;
      continue;
    }
    const endedMs = Date.parse(record.endedAt);
    if (Number.isNaN(endedMs) || now - endedMs < retentionMs) {
      result.skipped += 1;
      continue;
    }
    if (options.worktreeBaseDir && !record.worktreePath.startsWith(options.worktreeBaseDir)) {
      result.skipped += 1;
      continue;
    }
    const workflow = new GitWorkflow(options.sourceCwd);
    let reclaimed = false;
    try {
      const directoryPresent = (await stat(record.worktreePath).catch(() => undefined))?.isDirectory() === true;
      if (options.dryRun) {
        // Dry run: the branch must exist for the reclamation to be possible.
        reclaimed = true;
      } else {
        await workflow.commitWorktreeChanges(record.worktreePath, `subagent ${record.taskId}: worktree snapshot before reclamation`).catch(() => undefined);
        await workflow.snapshotBranchToRef(record.worktreeBranch, `refs/mini-agent/subagents/${record.taskId}`);
        if (directoryPresent) {
          reclaimed = await workflow.removeWorktree(record.worktreePath);
        } else {
          // Directory already gone: the branch + snapshot ref are enough to
          // keep the work recoverable; nothing left to remove.
          reclaimed = true;
        }
      }
    } catch {
      reclaimed = false;
    }
    if (reclaimed) {
      if (!options.dryRun) {
        await options.registry.markWorktreeReclaimed(record.taskId, record.ownerSessionId).catch(() => undefined);
      }
      result.reclaimed += 1;
      if (options.dryRun) result.wouldReclaim = (result.wouldReclaim ?? 0) + 1;
    } else {
      result.failed += 1;
    }
  }
  return result;
}
