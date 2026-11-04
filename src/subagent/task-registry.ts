import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentMessage } from "../types.ts";
import type { SubagentArgs, SubagentRuntimeInfo } from "./types.ts";

export type SubagentTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export type SubagentTaskRecord = {
  taskId: string;
  ownerSessionId?: string;
  task: string;
  profile?: string;
  args: Omit<SubagentArgs, "action" | "taskIds" | "taskId" | "waitTimeoutMs" | "waitMode">;
  status: SubagentTaskStatus;
  runInBackground: boolean;
  workerPid?: number;
  processPid?: number;
  workerOptions?: Record<string, unknown>;
  createdAt: string;
  startedAt: string;
  endedAt?: string;
  result?: string;
  isError?: boolean;
  partial?: boolean;
  error?: string;
  messages?: AgentMessage[];
  runtime?: SubagentRuntimeInfo;
  killed: boolean;
  blockWaited: boolean;
  completionConsumed: boolean;
  wakeQueued?: boolean;
  wakeDelivered: boolean;
  wakeSuppressed?: "disabled" | "goal_active";
};

type ActiveTask = {
  controller?: AbortController;
  writes: Promise<void>;
};

type SubagentInputMessage = { content: string; createdAt: string };

export type SubagentWaitResult = {
  mode: "any" | "all";
  completed: SubagentTaskRecord[];
  pending: string[];
  timedOut: boolean;
};

function validTaskId(taskId: string): boolean {
  return /^sub_[a-f0-9-]{36}$/i.test(taskId);
}

function cloneRecord(record: SubagentTaskRecord): SubagentTaskRecord {
  return structuredClone(record);
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isActiveStatus(status: SubagentTaskStatus): boolean {
  return status === "queued" || status === "running";
}

export class SubagentTaskRegistry {
  private readonly records = new Map<string, SubagentTaskRecord>();
  private readonly active = new Map<string, ActiveTask>();
  private readonly listeners = new Set<() => void>();
  private readonly queuedWakeups = new Set<string>();
  private initialized = false;
  private initialization?: Promise<void>;
  private readonly workspaceRoot?: string;
  private storageRoot?: string;

  constructor(workspaceRoot?: string) {
    if (workspaceRoot) this.workspaceRoot = resolve(workspaceRoot);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialization ??= this.load();
    try {
      await this.initialization;
      this.initialized = true;
    } catch (error) {
      this.initialization = undefined;
      throw error;
    }
  }

  private async load(): Promise<void> {
    if (!this.workspaceRoot) return;
    const canonicalWorkspace = await realpath(this.workspaceRoot);
    this.storageRoot = join(canonicalWorkspace, ".subagent-tasks");
    await mkdir(this.storageRoot, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(this.storageRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("Sub-agent task storage must be a real directory inside the workspace.");
    }
    const canonicalStorage = await realpath(this.storageRoot);
    const relativeStorage = relative(canonicalWorkspace, canonicalStorage);
    if (relativeStorage.startsWith("..") || isAbsolute(relativeStorage)) {
      throw new Error("Sub-agent task storage resolved outside the workspace.");
    }
    await chmod(this.storageRoot, 0o700).catch(() => undefined);
    await this.refreshFromDisk();
  }

  private async refreshFromDisk(): Promise<void> {
    if (!this.storageRoot) return;
    const files = await readdir(this.storageRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const file of files.filter((name) => /^sub_[a-f0-9-]{36}\.json$/i.test(name))) {
      const path = join(this.storageRoot, file);
      const fileStat = await lstat(path);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) continue;
      const parsed = JSON.parse(await readFile(path, "utf8")) as SubagentTaskRecord;
      if (!parsed || !validTaskId(parsed.taskId) || parsed.taskId !== file.slice(0, -5)) continue;
      const active = this.active.get(parsed.taskId);
      if (active) {
        const local = this.records.get(parsed.taskId);
        if (!local) continue;
        let changed = false;
        if (parsed.killed && !local.killed) {
          local.killed = true;
          active.controller?.abort("user_killed");
          changed = true;
        }
        for (const key of ["blockWaited", "completionConsumed", "wakeQueued", "wakeDelivered", "wakeSuppressed"] as const) {
          if (parsed[key] !== undefined && local[key] !== parsed[key]) {
            local[key] = parsed[key] as never;
            changed = true;
          }
        }
        if (changed) this.notify();
        continue;
      }
      const ownerPid = parsed.workerPid ?? parsed.processPid;
      if (isActiveStatus(parsed.status) && (ownerPid === undefined || !isProcessAlive(ownerPid))) {
        parsed.status = parsed.killed ? "cancelled" : "interrupted";
        parsed.error = parsed.killed
          ? "The background sub-agent was stopped."
          : "The application stopped while this sub-agent was running.";
        parsed.endedAt = new Date().toISOString();
        await this.write(parsed);
      }
      const previous = this.records.get(parsed.taskId);
      if (previous && JSON.stringify(previous) === JSON.stringify(parsed)) continue;
      this.records.set(parsed.taskId, parsed);
      this.notify();
    }
  }

  async start(record: SubagentTaskRecord, controller?: AbortController): Promise<void> {
    await this.initialize();
    record.processPid = process.pid;
    this.records.set(record.taskId, record);
    this.active.set(record.taskId, { ...(controller ? { controller } : {}), writes: Promise.resolve() });
    await this.persist(record.taskId);
    this.notify();
  }

  /** Stop treating a task as process-local after handing it to a detached worker. */
  async detach(taskId: string): Promise<void> {
    await this.initialize();
    this.active.delete(taskId);
    await this.refreshFromDisk();
    this.notify();
  }

  async markBackground(taskId: string): Promise<void> {
    await this.initialize();
    const record = this.records.get(taskId);
    if (!record) return;
    record.runInBackground = true;
    await this.persist(taskId);
    this.notify();
  }

  async setWorkerPid(taskId: string, workerPid: number): Promise<void> {
    await this.initialize();
    const record = this.records.get(taskId);
    if (!record || !Number.isSafeInteger(workerPid) || workerPid <= 0) return;
    record.workerPid = workerPid;
    await this.persist(taskId);
    this.notify();
  }

  async setWorkerOptions(taskId: string, workerOptions: Record<string, unknown>): Promise<void> {
    await this.initialize();
    const record = this.records.get(taskId);
    if (!record) return;
    record.workerOptions = structuredClone(workerOptions);
    await this.persist(taskId);
  }

  async claimInterruptedForRestart(taskId: string, ownerSessionId?: string): Promise<SubagentTaskRecord | undefined> {
    await this.initialize();
    if (!this.storageRoot || !validTaskId(taskId)) return undefined;
    const path = join(this.storageRoot, `${taskId}.json`);
    const lockPath = `${path}.lock`;
    const lock = await this.acquireInboxLock(lockPath, taskId);
    try {
      const current = await readFile(path, "utf8")
        .then((value) => JSON.parse(value) as SubagentTaskRecord)
        .catch(() => undefined);
      if (!current || current.ownerSessionId !== ownerSessionId || current.status !== "interrupted" || current.killed) return undefined;
      const next: SubagentTaskRecord = {
        ...current,
        status: "queued",
        startedAt: new Date().toISOString(),
        killed: false,
        blockWaited: false,
        completionConsumed: false,
        wakeQueued: false,
        wakeDelivered: false,
      };
      delete next.endedAt;
      delete next.error;
      delete next.workerPid;
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, path);
        await chmod(path, 0o600).catch(() => undefined);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      this.records.set(taskId, next);
      this.notify();
      return cloneRecord(next);
    } finally {
      await lock.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async finish(
    taskId: string,
    update: Pick<SubagentTaskRecord, "status" | "result" | "isError" | "partial" | "error" | "messages" | "runtime">,
  ): Promise<void> {
    await this.initialize();
    await this.refreshFromDisk();
    const record = this.records.get(taskId);
    if (!record) return;
    record.status = record.killed || update.status === "cancelled" ? "cancelled" : update.status;
    record.result = update.result;
    record.isError = update.isError;
    record.partial = update.partial;
    record.error = update.error;
    record.messages = update.messages;
    record.runtime = update.runtime;
    record.endedAt = new Date().toISOString();
    await this.persist(taskId);
    this.active.delete(taskId);
    this.notify();
  }

  async checkpoint(taskId: string, messages: AgentMessage[]): Promise<void> {
    await this.initialize();
    await this.refreshFromDisk();
    const record = this.records.get(taskId);
    if (!record || record.status !== "running" || record.killed) return;
    record.messages = structuredClone(messages);
    await this.persist(taskId);
  }

  async sendInputMessage(taskId: string, content: string, ownerSessionId?: string): Promise<boolean> {
    await this.initialize();
    await this.refreshFromDisk();
    if (!validTaskId(taskId) || !content.trim()) return false;
    const record = this.records.get(taskId);
    if (!record || record.ownerSessionId !== ownerSessionId || !isActiveStatus(record.status)) return false;
    if (!this.storageRoot) return false;
    const inboxPath = join(this.storageRoot, `${taskId}.inbox.json`);
    const lockPath = `${inboxPath}.lock`;
    const lock = await this.acquireInboxLock(lockPath, taskId);
    try {
      const latest = await readFile(join(this.storageRoot, `${taskId}.json`), "utf8")
        .then((value) => JSON.parse(value) as SubagentTaskRecord)
        .catch(() => undefined);
      if (!latest || latest.ownerSessionId !== ownerSessionId || !isActiveStatus(latest.status) || latest.killed) return false;
      const messages = await this.readInbox(inboxPath);
      if (messages.length >= 30 || messages.reduce((size, message) => size + message.content.length, 0) + content.length > 50_000) return false;
      messages.push({ content, createdAt: new Date().toISOString() });
      await this.writeInbox(inboxPath, messages);
      return true;
    } finally {
      await lock.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async takeInputMessages(taskId: string): Promise<string[]> {
    await this.initialize();
    if (!validTaskId(taskId) || !this.storageRoot) return [];
    const inboxPath = join(this.storageRoot, `${taskId}.inbox.json`);
    const lockPath = `${inboxPath}.lock`;
    const lock = await this.acquireInboxLock(lockPath, taskId);
    try {
      const messages = await this.readInbox(inboxPath);
      if (messages.length > 0) await this.writeInbox(inboxPath, []);
      return messages.map((message) => message.content);
    } finally {
      await lock.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async readGlobalTokenUsage(budgetId: string): Promise<number> {
    await this.initialize();
    if (!this.storageRoot || !/^[a-f0-9-]{36}$/i.test(budgetId)) return 0;
    const path = join(this.storageRoot, `budget_${budgetId}.json`);
    const current = await this.readJsonFile<{ used?: number }>(path);
    return Number(current?.used) || 0;
  }

  async readGlobalCallUsage(budgetId: string): Promise<number> {
    await this.initialize();
    if (!this.storageRoot || !/^[a-f0-9-]{36}$/i.test(budgetId)) return 0;
    const path = join(this.storageRoot, `budget_${budgetId}.json`);
    const current = await this.readJsonFile<{ callsUsed?: number }>(path);
    return Number(current?.callsUsed) || 0;
  }

  async consumeGlobalTokens(budgetId: string, delta: number): Promise<number> {
    await this.initialize();
    if (!this.storageRoot || !/^[a-f0-9-]{36}$/i.test(budgetId) || !Number.isFinite(delta) || delta <= 0) {
      return this.readGlobalTokenUsage(budgetId);
    }
    const path = join(this.storageRoot, `budget_${budgetId}.json`);
    const lockPath = `${path}.lock`;
    const lock = await this.acquireInboxLock(lockPath, `budget_${budgetId}`);
    try {
      const current = await this.readJsonFile<{ used?: number; callsUsed?: number }>(path) ?? {};
      const used = (Number(current.used) || 0) + delta;
      await this.writeJsonAtomic(path, { ...current, used });
      return used;
    } finally {
      await lock.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async reserveGlobalCalls(budgetId: string, count: number, limit: number): Promise<number | undefined> {
    await this.initialize();
    if (!this.storageRoot || !/^[a-f0-9-]{36}$/i.test(budgetId) || !Number.isSafeInteger(count) || count < 1) return undefined;
    const path = join(this.storageRoot, `budget_${budgetId}.json`);
    const lockPath = `${path}.lock`;
    const lock = await this.acquireInboxLock(lockPath, `budget_${budgetId}`);
    try {
      const current = await this.readJsonFile<{ used?: number; callsUsed?: number }>(path) ?? {};
      const callsUsed = Number(current.callsUsed) || 0;
      if (callsUsed + count > limit) return undefined;
      const next = callsUsed + count;
      await this.writeJsonAtomic(path, { ...current, callsUsed: next });
      return next;
    } finally {
      await lock.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async acquireGlobalConcurrencySlot(
    scopeId: string,
    taskId: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.initialize();
    if (!this.storageRoot || !/^[a-f0-9-]{36}$/i.test(scopeId) || !Number.isSafeInteger(limit) || limit < 1) return;
    const path = join(this.storageRoot, `concurrency_${scopeId}.json`);
    const lockPath = `${path}.lock`;
    while (true) {
      if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
      const lock = await this.acquireInboxLock(lockPath, `concurrency_${scopeId}`);
      let acquired = false;
      try {
        const saved = await this.readJsonFile<{ leases?: Array<{ taskId: string; pid: number }> }>(path) ?? {};
        const leases = (saved.leases ?? []).filter((lease) => isProcessAlive(lease.pid));
        if (leases.some((lease) => lease.taskId === taskId)) {
          acquired = true;
        } else if (leases.length < limit) {
          leases.push({ taskId, pid: process.pid });
          await this.writeJsonAtomic(path, { leases });
          acquired = true;
        }
      } finally {
        await lock.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      }
      if (acquired) return;
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve();
        };
        const onAbort = () => finish(Object.assign(new Error("Operation aborted"), { name: "AbortError" }));
        const timer = setTimeout(() => finish(), 50);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  async releaseGlobalConcurrencySlot(scopeId: string, taskId: string): Promise<void> {
    await this.initialize();
    if (!this.storageRoot || !/^[a-f0-9-]{36}$/i.test(scopeId)) return;
    const path = join(this.storageRoot, `concurrency_${scopeId}.json`);
    const lockPath = `${path}.lock`;
    const lock = await this.acquireInboxLock(lockPath, `concurrency_${scopeId}`);
    try {
      const saved = await this.readJsonFile<{ leases?: Array<{ taskId: string; pid: number }> }>(path) ?? {};
      const leases = (saved.leases ?? []).filter((lease) => lease.taskId !== taskId && isProcessAlive(lease.pid));
      await this.writeJsonAtomic(path, { leases });
    } finally {
      await lock.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async get(taskId: string, ownerSessionId?: string): Promise<SubagentTaskRecord | undefined> {
    await this.initialize();
    await this.refreshFromDisk();
    if (!validTaskId(taskId)) return undefined;
    const record = this.records.get(taskId);
    return record && record.ownerSessionId === ownerSessionId ? cloneRecord(record) : undefined;
  }

  async list(ownerSessionId?: string): Promise<SubagentTaskRecord[]> {
    await this.initialize();
    await this.refreshFromDisk();
    return [...this.records.values()]
      .filter((record) => record.ownerSessionId === ownerSessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(cloneRecord);
  }

  async readOutput(taskId: string, ownerSessionId?: string): Promise<SubagentTaskRecord | undefined> {
    await this.initialize();
    await this.refreshFromDisk();
    const record = this.records.get(taskId);
    if (!record || record.ownerSessionId !== ownerSessionId) return undefined;
    if (!isActiveStatus(record.status)) {
      record.completionConsumed = true;
      record.blockWaited = false;
      record.wakeQueued = false;
      record.wakeDelivered = true;
      this.queuedWakeups.delete(taskId);
      await this.persist(taskId);
      this.notify();
    }
    return cloneRecord(record);
  }

  async kill(taskId: string, ownerSessionId?: string): Promise<SubagentTaskRecord | undefined> {
    await this.initialize();
    await this.refreshFromDisk();
    const record = this.records.get(taskId);
    if (!record || record.ownerSessionId !== ownerSessionId) return undefined;
    if (!isActiveStatus(record.status)) return cloneRecord(record);
    record.killed = true;
    record.wakeQueued = false;
    record.wakeDelivered = true;
    this.queuedWakeups.delete(taskId);
    this.active.get(taskId)?.controller?.abort("user_killed");
    if (record.workerPid !== undefined && isProcessAlive(record.workerPid)) {
      try {
        process.kill(record.workerPid, "SIGTERM");
      } catch {
        // A worker can finish between the liveness check and the signal.
      }
    }
    await this.persist(taskId);
    this.notify();
    return cloneRecord(record);
  }

  async wait(
    taskIds: string[],
    mode: "any" | "all" = "all",
    timeoutMs = 30_000,
    signal?: AbortSignal,
    ownerSessionId?: string,
  ): Promise<SubagentWaitResult> {
    await this.initialize();
    await this.refreshFromDisk();
    const uniqueIds = [...new Set(taskIds)].slice(0, 20);
    const records = uniqueIds
      .map((id) => this.records.get(id))
      .filter((record): record is SubagentTaskRecord => Boolean(record && record.ownerSessionId === ownerSessionId));
    for (const record of records) {
      if (isActiveStatus(record.status)) record.blockWaited = true;
    }
    await Promise.all(records.map((record) => this.persist(record.taskId)));

    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Date.now();
    let timedOut = false;
    while (true) {
      await this.refreshFromDisk();
      if (signal?.aborted) {
        for (const record of records) {
          record.blockWaited = false;
          await this.persist(record.taskId);
        }
        this.notify();
        throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
      }
      const terminal = records.filter((record) => !isActiveStatus(record.status));
      if (mode === "any" ? terminal.length > 0 : terminal.length === records.length) break;
      if (timeoutMs <= 0 || Date.now() >= deadline) {
        timedOut = records.some((record) => isActiveStatus(record.status));
        break;
      }
      await this.waitForChange(Math.min(100, deadline - Date.now()), signal);
    }

    for (const record of records) {
      if (!isActiveStatus(record.status)) {
        record.blockWaited = false;
        record.completionConsumed = true;
        record.wakeQueued = false;
        record.wakeDelivered = true;
        this.queuedWakeups.delete(record.taskId);
        await this.persist(record.taskId);
      } else {
        record.blockWaited = false;
        await this.persist(record.taskId);
      }
    }
    this.notify();
    const completed = records.filter((record) => !isActiveStatus(record.status)).map(cloneRecord);
    const pending = records.filter((record) => isActiveStatus(record.status)).map((record) => record.taskId);
    return { mode, completed, pending, timedOut };
  }

  async claimAutoWake(taskId: string, ownerSessionId: string | undefined, enabled: boolean, goalLoopActive: boolean): Promise<boolean> {
    await this.initialize();
    await this.refreshFromDisk();
    const record = this.records.get(taskId);
    if (!record || record.ownerSessionId !== ownerSessionId || !record.runInBackground) return false;
    if (record.status !== "completed" && record.status !== "failed") return false;
    if (record.killed || record.completionConsumed || record.blockWaited || record.wakeDelivered || record.wakeSuppressed) return false;
    if (this.queuedWakeups.has(taskId)) return false;
    if (!enabled || goalLoopActive) {
      record.wakeQueued = false;
      record.wakeSuppressed = enabled ? "goal_active" : "disabled";
      record.wakeDelivered = true;
      this.queuedWakeups.delete(taskId);
      await this.persist(taskId);
      return false;
    }
    if (record.wakeQueued) {
      this.queuedWakeups.add(taskId);
      return true;
    }
    record.wakeQueued = true;
    this.queuedWakeups.add(taskId);
    await this.persist(taskId);
    return true;
  }

  async markAutoWakeDelivered(taskId: string, ownerSessionId?: string): Promise<boolean> {
    await this.initialize();
    await this.refreshFromDisk();
    const record = this.records.get(taskId);
    if (!record || record.ownerSessionId !== ownerSessionId || !record.wakeQueued) return false;
    if (record.completionConsumed || record.killed || record.wakeSuppressed
      || (record.status !== "completed" && record.status !== "failed")) {
      record.wakeQueued = false;
      record.wakeDelivered = true;
      this.queuedWakeups.delete(taskId);
      await this.persist(taskId);
      return false;
    }
    record.wakeQueued = false;
    record.wakeDelivered = true;
    this.queuedWakeups.delete(taskId);
    await this.persist(taskId);
    return true;
  }

  async releaseAutoWake(taskId: string, ownerSessionId?: string): Promise<void> {
    await this.initialize();
    await this.refreshFromDisk();
    const record = this.records.get(taskId);
    if (!record || record.ownerSessionId !== ownerSessionId || record.completionConsumed || record.killed || record.wakeSuppressed) return;
    record.wakeQueued = false;
    record.wakeDelivered = false;
    this.queuedWakeups.delete(taskId);
    await this.persist(taskId);
    this.notify();
  }

  async pendingWakeups(ownerSessionId?: string): Promise<SubagentTaskRecord[]> {
    await this.initialize();
    await this.refreshFromDisk();
    return [...this.records.values()]
      .filter((record) => record.ownerSessionId === ownerSessionId
        && record.runInBackground
        && (record.status === "completed" || record.status === "failed")
        && !record.killed
        && !record.completionConsumed
        && !record.blockWaited
        && !record.wakeDelivered
        && !record.wakeSuppressed
        && (!record.wakeQueued || !this.queuedWakeups.has(record.taskId)))
      .map(cloneRecord);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async waitForChange(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.listeners.delete(finish);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, timeoutMs));
      this.listeners.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private async persist(taskId: string): Promise<void> {
    const record = this.records.get(taskId);
    if (!record || !this.storageRoot) return;
    const active = this.active.get(taskId);
    if (!active) {
      await this.write(record);
      return;
    }
    const snapshot = cloneRecord(record);
    active.writes = active.writes.catch(() => undefined).then(() => this.write(snapshot));
    await active.writes;
  }

  private async write(record: SubagentTaskRecord): Promise<void> {
    if (!this.storageRoot) return;
    await mkdir(this.storageRoot, { recursive: true, mode: 0o700 });
    const path = join(this.storageRoot, `${record.taskId}.json`);
    const lockPath = `${path}.lock`;
    const deadline = Date.now() + 10_000;
    let lock;
    while (!lock) {
      try {
        lock = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const lockStat = await lstat(lockPath).catch(() => undefined);
        if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out locking sub-agent task ${record.taskId}.`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      let next = cloneRecord(record);
      const existing = await readFile(path, "utf8").then((value) => JSON.parse(value) as SubagentTaskRecord).catch(() => undefined);
      if (existing?.killed) {
        next.killed = true;
        if (!isActiveStatus(next.status)) next.status = "cancelled";
      }
      await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temp, path);
      await chmod(path, 0o600).catch(() => undefined);
      const local = this.records.get(record.taskId);
      if (local && next.killed && !local.killed) local.killed = true;
    } finally {
      await unlink(temp).catch(() => undefined);
      await lock.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private async acquireInboxLock(lockPath: string, taskId: string) {
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        return await open(lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const lockStat = await lstat(lockPath).catch(() => undefined);
        if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out locking sub-agent input ${taskId}.`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  private async writeInbox(path: string, messages: SubagentInputMessage[]): Promise<void> {
    await this.writeJsonAtomic(path, messages);
  }

  private async readInbox(path: string): Promise<SubagentInputMessage[]> {
    const parsed = await this.readJsonFile<unknown>(path);
    if (parsed === undefined) return [];
    if (!Array.isArray(parsed) || parsed.some((entry) => !entry || typeof entry.content !== "string" || typeof entry.createdAt !== "string")) {
      throw new Error("Sub-agent input queue is malformed.");
    }
    return parsed as SubagentInputMessage[];
  }

  private async readJsonFile<T>(path: string): Promise<T | undefined> {
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) return undefined;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Sub-agent task data must be a regular file.");
    return JSON.parse(await readFile(path, "utf8")) as T;
  }

  private async writeJsonAtomic(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, path);
      await chmod(path, 0o600).catch(() => undefined);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

export function createSubagentTaskId(): string {
  return `sub_${randomUUID()}`;
}
