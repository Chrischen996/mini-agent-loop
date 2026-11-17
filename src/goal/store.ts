import { mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getDataRoot } from "../session-store.ts";
import {
  GOAL_STATUSES,
  type GoalState,
  type GoalStatus,
} from "./types.ts";

export type GoalStoreOptions = {
  /** Override the data root (defaults to AGENT_DATA_DIR / ~/.mini-agent). */
  dataDir?: string;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseGoal(value: unknown): GoalState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionId !== "string" ||
    typeof record.goalId !== "string" ||
    typeof record.objective !== "string" ||
    typeof record.status !== "string" ||
    !(GOAL_STATUSES as readonly string[]).includes(record.status) ||
    !isFiniteNumber(record.tokensUsed) ||
    !isFiniteNumber(record.timeUsedSeconds) ||
    !isFiniteNumber(record.createdAt) ||
    !isFiniteNumber(record.updatedAt)
  ) return undefined;
  if (record.tokenBudget !== undefined && record.tokenBudget !== null &&
    (!isFiniteNumber(record.tokenBudget) || record.tokenBudget <= 0)) return undefined;
  return {
    sessionId: record.sessionId,
    goalId: record.goalId,
    objective: record.objective,
    status: record.status as GoalStatus,
    ...(record.tokenBudget === undefined || record.tokenBudget === null
      ? {}
      : { tokenBudget: record.tokenBudget as number }),
    tokensUsed: Math.max(0, Math.floor(record.tokensUsed as number)),
    timeUsedSeconds: Math.max(0, Math.floor(record.timeUsedSeconds as number)),
    createdAt: record.createdAt as number,
    updatedAt: record.updatedAt as number,
    // Background-runner coordinates (optional; absent for foreground goals).
    ...(typeof record.backgroundTaskId === "string" ? { backgroundTaskId: record.backgroundTaskId } : {}),
    ...(typeof record.worktreeDir === "string" ? { worktreeDir: record.worktreeDir } : {}),
    ...(typeof record.worktreeBranch === "string" ? { worktreeBranch: record.worktreeBranch } : {}),
  };
}

/**
 * Per-session goal store. One goal per session id, persisted atomically as a
 * small JSON file under `<dataRoot>/goals/<sessionId>.json`. Corrupt or
 * unreadable files are treated as "no goal" rather than crashing a client.
 */
export class GoalStore {
  private readonly root: string;
  private readonly goalsRoot: string;
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(options: GoalStoreOptions = {}) {
    this.goalsRoot = path.join(path.resolve(options.dataDir ?? getDataRoot()), "goals");
    this.root = this.goalsRoot;
  }

  private file(sessionId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      throw new Error("Invalid session id for goal store");
    }
    return path.join(this.root, `${sessionId}.json`);
  }

  private async withFileLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.goalsRoot, { recursive: true, mode: 0o700 });
    const lockPath = `${this.file(sessionId)}.lock`;
    const deadline = Date.now() + 10_000;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    while (!handle) {
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const info = await stat(lockPath).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs > 30_000) await unlink(lockPath).catch(() => undefined);
        if (Date.now() >= deadline) throw new Error(`Timed out locking goal ${sessionId}.`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.pending.set(sessionId, next);
    // The finally chain re-rejects; swallow it so expected rejections (for
    // example from assert.rejects callers) are not reported as unhandled.
    void next.catch(() => {}).finally(() => {
      if (this.pending.get(sessionId) === next) this.pending.delete(sessionId);
    });
    return next;
  }

  private async readGoal(sessionId: string): Promise<GoalState | undefined> {
    try {
      return parseGoal(JSON.parse(await readFile(this.file(sessionId), "utf8")));
    } catch {
      return undefined;
    }
  }

  private async writeGoal(goal: GoalState): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const target = this.file(goal.sessionId);
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(goal)}\n`, { mode: 0o600 });
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
  }

  async get(sessionId: string): Promise<GoalState | undefined> {
    return this.withFileLock(sessionId, () => this.readGoal(sessionId));
  }

  async write(goal: GoalState): Promise<GoalState> {
    return this.serialize(goal.sessionId, async () => {
      return this.withFileLock(goal.sessionId, async () => {
        await this.writeGoal(goal);
        return goal;
      });
    });
  }

  async clear(sessionId: string): Promise<boolean> {
    return this.serialize(sessionId, async () => {
      return this.withFileLock(sessionId, async () => {
        try {
          await rm(this.file(sessionId));
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      });
    });
  }

  /** Update the goal under the store lock, optionally requiring the current goal id. */
  async update(
    sessionId: string,
    mutator: (current: GoalState | undefined) => GoalState | undefined | Promise<GoalState | undefined>,
  ): Promise<GoalState | undefined> {
    return this.serialize(sessionId, async () => {
      return this.withFileLock(sessionId, async () => {
        const current = await this.readGoal(sessionId);
        const next = await mutator(current);
        if (!next) return current;
        await this.writeGoal(next);
        return next;
      });
    });
  }
}

export function defaultGoalStore(options: GoalStoreOptions = {}): GoalStore {
  return new GoalStore(options);
}
