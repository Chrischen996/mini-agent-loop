import { EventEmitter } from "node:events";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { open, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { BgTaskStore, type TaskMeta, type TaskPaths, type TaskResult } from "./store.js";
import { BgTmuxBackend } from "./tmux.js";

export interface BgTaskSummary {
  taskId: string;
  name: string;
  command: string;
  cwd: string;
  status: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  ownedByCurrentInstance: boolean;
  sessionName: string;
  socketName: string;
  logPath: string;
  attachCommand?: string;
  reason?: string;
}

export interface LogChunk {
  taskId: string;
  text: string;
  offset: number;
  nextOffset: number;
  endOfLog: boolean;
}

export interface StartTaskInput {
  command: string;
  cwd?: string;
  name?: string;
  timeoutSeconds?: number;
}

export interface SendTaskInput {
  text?: string;
  enter?: boolean;
}

export interface WaitResult {
  mode: "any" | "all";
  completed: BgTaskSummary[];
  pending: string[];
  timedOut: boolean;
}

function isTerminalStatus(status: string): boolean {
  return !["starting", "running", "unknown"].includes(status);
}

function completeUtf8PrefixLength(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let lead = buffer.length - 1;
  while (lead >= 0 && (buffer[lead]! & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return 0;
  const byte = buffer[lead]!;
  const expected = byte < 0x80 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
  return buffer.length - lead < expected ? lead : buffer.length;
}

export class BgTaskManager extends EventEmitter {
  readonly store: BgTaskStore;
  readonly backend: BgTmuxBackend;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timeoutTimers = new Map<string, NodeJS.Timeout>();
  private readonly seenCompletions = new Set<string>();
  private readonly activeWaiters = new Map<string, number>();
  private reconciliationTimer?: NodeJS.Timeout;
  private cleanupHandler?: () => void;
  private disposed = false;

  constructor(
    readonly projectCwd: string,
    readonly instanceId: string,
    runnerPath?: string,
  ) {
    super();
    this.store = new BgTaskStore(projectCwd, instanceId);
    this.backend = new BgTmuxBackend(
      `pi-bg-${instanceId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 56)}`,
      runnerPath ?? fileURLToPath(new URL("./runner.js", import.meta.url)),
    );

    this.cleanupHandler = () => {
      this.dispose();
      void this.backend.killServer();
    };
    process.once("exit", this.cleanupHandler);
    process.once("SIGINT", this.cleanupHandler);
    process.once("SIGTERM", this.cleanupHandler);
  }

  async initialize(): Promise<void> {
    await this.backend.assertAvailable();
    await this.store.initialize();
    for (const taskId of await this.store.listOwnTaskIds()) {
      this.watchTask(taskId);
      await this.restoreTimeout(taskId);
    }
    await this.reconcile();
    this.reconciliationTimer = setInterval(() => void this.reconcile(), 1000);
    this.reconciliationTimer.unref();
  }

  async start(input: StartTaskInput): Promise<BgTaskSummary> {
    if (!input.command.trim()) throw new Error("command must not be empty");
    const taskId = `bg_${randomUUID().replace(/-/g, "")}`;
    const meta: TaskMeta = {
      schemaVersion: 1,
      taskId,
      name: input.name?.trim() || input.command.trim().slice(0, 80),
      command: input.command,
      cwd: input.cwd ?? this.projectCwd,
      shell: process.env.SHELL || "/bin/sh",
      status: "starting",
      createdAt: new Date().toISOString(),
      notifyOnCompletion: true,
      ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
    };
    const paths = await this.store.createTask(meta);
    const sessionName = `pi-${taskId}`;
    try {
      await this.backend.start(sessionName, meta.cwd, paths.dir);
      await this.backend.pipePane(sessionName, paths.log);
      await this.store.signalStart(paths);
      const startedAt = new Date().toISOString();
      await this.store.updateMeta(paths, (current) => ({ ...current, status: "running", startedAt }));
      this.watchTask(taskId);
      this.scheduleTimeout(taskId, startedAt, input.timeoutSeconds);
      const summary = await this.get(taskId);
      if (!summary) throw new Error("Task start returned no summary");
      this.emit("changed", summary);
      return summary;
    } catch (error) {
      await this.backend.kill(sessionName).catch(() => undefined);
      await this.store.writeResult(paths, {
        schemaVersion: 1,
        taskId,
        status: "failed",
        exitCode: null,
        signal: null,
        endedAt: new Date().toISOString(),
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async get(taskId: string): Promise<BgTaskSummary | undefined> {
    const paths = await this.store.findTask(taskId);
    if (!paths) return undefined;
    const meta = await this.store.readMeta(paths);
    if (!meta) return undefined;
    const result = await this.store.readResult(paths);
    let status: string = result?.status ?? meta.status;
    if (!result) {
      if (!(await this.backend.hasSession(`pi-${taskId}`))) {
        const interrupted: TaskResult = {
          schemaVersion: 1,
          taskId,
          status: "interrupted",
          exitCode: null,
          signal: null,
          startedAt: meta.startedAt,
          endedAt: new Date().toISOString(),
          reason: "tmux session disappeared without a result",
        };
        await this.store.writeResult(paths, interrupted);
        status = "interrupted";
      }
    }
    const finalResult = result ?? (await this.store.readResult(paths));
    const start = finalResult?.startedAt ?? meta.startedAt ?? meta.createdAt;
    const end = finalResult?.endedAt;
    return {
      taskId,
      name: meta.name,
      command: meta.command,
      cwd: meta.cwd,
      status: finalResult?.status ?? status,
      createdAt: meta.createdAt,
      startedAt: meta.startedAt,
      endedAt: end,
      durationMs: end ? Math.max(0, Date.parse(end) - Date.parse(start)) : Math.max(0, Date.now() - Date.parse(start)),
      exitCode: finalResult?.exitCode ?? null,
      signal: finalResult?.signal ?? null,
      ownedByCurrentInstance: true,
      sessionName: `pi-${taskId}`,
      socketName: this.backend.socketName,
      logPath: paths.log,
      attachCommand: finalResult ? undefined : this.backend.attachCommand(`pi-${taskId}`),
      reason: finalResult?.reason,
    };
  }

  async list(): Promise<BgTaskSummary[]> {
    const ids = await this.store.listOwnTaskIds();
    const results: BgTaskSummary[] = [];
    for (const id of ids) {
      const summary = await this.get(id);
      if (summary) results.push(summary);
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async logs(taskId: string, offset = 0, limitBytes = 16 * 1024): Promise<LogChunk> {
    const paths = await this.store.findTask(taskId);
    if (!paths) throw new Error(`Task not found: ${taskId}`);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 4 || limitBytes > 65536) {
      throw new Error("limitBytes must be between 4 and 65536");
    }
    const size = (await stat(paths.log)).size;
    const start = Math.min(offset, size);
    const bytesToRead = Math.min(limitBytes, size - start);
    const buffer = Buffer.alloc(bytesToRead);
    const handle = await open(paths.log, "r");
    let bytesRead = 0;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, bytesToRead, start));
    } finally {
      await handle.close();
    }
    const safeLength = completeUtf8PrefixLength(buffer.subarray(0, bytesRead));
    return {
      taskId,
      text: buffer.subarray(0, safeLength).toString("utf8"),
      offset: start,
      nextOffset: start + safeLength,
      endOfLog: start + safeLength >= size,
    };
  }

  async screen(taskId: string, lines = 200): Promise<LogChunk> {
    const paths = await this.store.findTask(taskId);
    if (!paths) throw new Error(`Task not found: ${taskId}`);
    const meta = await this.store.readMeta(paths);
    if (!meta) throw new Error(`Task metadata is missing: ${taskId}`);
    if (!(await this.backend.hasSession(`pi-${taskId}`))) throw new Error(`Task is not running: ${taskId}`);
    const raw = await this.backend.capturePane(`pi-${taskId}`, lines);
    return {
      taskId,
      text: raw,
      offset: 0,
      nextOffset: Buffer.byteLength(raw),
      endOfLog: true,
    };
  }

  async send(taskId: string, input: SendTaskInput): Promise<BgTaskSummary> {
    const summary = await this.get(taskId);
    if (!summary) throw new Error(`Task not found: ${taskId}`);
    if (isTerminalStatus(summary.status)) throw new Error(`Task is not running: ${taskId}`);
    if (input.text === undefined && !input.enter) throw new Error("Provide text or enter");
    if (input.text !== undefined) await this.backend.sendLiteral(summary.sessionName, input.text);
    if (input.enter) await this.backend.sendKey(summary.sessionName, "Enter");
    return summary;
  }

  async terminate(taskId: string, force = false): Promise<BgTaskSummary> {
    const paths = await this.store.findTask(taskId);
    if (!paths) throw new Error(`Task not found: ${taskId}`);
    const current = await this.get(taskId);
    if (!current) throw new Error(`Task not found: ${taskId}`);
    if (isTerminalStatus(current.status)) return current;
    await this.store.writeCancellation(paths, "cancelled");
    if (!force && (await this.backend.hasSession(current.sessionName))) {
      await this.backend.sendKey(current.sessionName, "C-c").catch(() => undefined);
      const ended = await this.waitForResult(paths, 1500);
      if (ended) {
        await this.processCompletion(taskId);
        return (await this.get(taskId)) ?? current;
      }
    }
    await this.backend.kill(current.sessionName).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    const result = await this.store.readResult(paths);
    if (!result) {
      await this.store.writeResult(paths, {
        schemaVersion: 1,
        taskId,
        status: "cancelled",
        exitCode: null,
        signal: force ? "SIGKILL" : "SIGHUP",
        startedAt: current.startedAt,
        endedAt: new Date().toISOString(),
        reason: "cancelled",
      });
    }
    await this.processCompletion(taskId);
    return (await this.get(taskId)) ?? current;
  }

  async wait(taskIds: string[], mode: "any" | "all" = "all", timeoutSeconds?: number, signal?: AbortSignal): Promise<WaitResult> {
    const unique = [...new Set(taskIds)];
    if (unique.length === 0) throw new Error("taskIds must not be empty");
    for (const taskId of unique) {
      const summary = await this.get(taskId);
      if (!summary) throw new Error(`Task not found: ${taskId}`);
      this.activeWaiters.set(taskId, (this.activeWaiters.get(taskId) ?? 0) + 1);
    }
    try {
      const deadline = timeoutSeconds === undefined ? undefined : Date.now() + timeoutSeconds * 1000;
      while (true) {
        if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
        const summaries = await Promise.all(unique.map((taskId) => this.get(taskId)));
        const valid = summaries.filter((s): s is BgTaskSummary => s !== undefined);
        const completed = valid.filter((task) => isTerminalStatus(task.status));
        const satisfied = mode === "all" ? completed.length === unique.length : completed.length > 0;
        if (satisfied) {
          return { mode, completed, pending: valid.filter((t) => !isTerminalStatus(t.status)).map((t) => t.taskId), timedOut: false };
        }
        if (deadline !== undefined && Date.now() >= deadline) {
          return { mode, completed, pending: valid.filter((t) => !isTerminalStatus(t.status)).map((t) => t.taskId), timedOut: true };
        }
        const waitMs = deadline === undefined ? 1000 : Math.max(1, Math.min(1000, deadline - Date.now()));
        await this.waitForCompletionEvent(waitMs, signal);
      }
    } finally {
      for (const taskId of unique) {
        const count = (this.activeWaiters.get(taskId) ?? 1) - 1;
        if (count <= 0) this.activeWaiters.delete(taskId);
        else this.activeWaiters.set(taskId, count);
      }
    }
  }

  isActivelyWaited(taskId: string): boolean {
    return (this.activeWaiters.get(taskId) ?? 0) > 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.cleanupHandler) {
      process.removeListener("exit", this.cleanupHandler);
      process.removeListener("SIGINT", this.cleanupHandler);
      process.removeListener("SIGTERM", this.cleanupHandler);
      this.cleanupHandler = undefined;
    }
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
    for (const watcher of this.watchers.values()) watcher.close();
    for (const timer of this.timeoutTimers.values()) clearTimeout(timer);
    this.watchers.clear();
    this.timeoutTimers.clear();
    this.removeAllListeners();
  }

  private watchTask(taskId: string): void {
    if (this.watchers.has(taskId)) return;
    const paths = this.store.paths(taskId);
    try {
      const watcher = watch(paths.dir, (_event, filename) => {
        if (filename === "result.json") void this.processCompletion(taskId);
      });
      watcher.on("error", () => {
        watcher.close();
        this.watchers.delete(taskId);
      });
      this.watchers.set(taskId, watcher);
    } catch {
      // The reconciliation timer remains the reliability fallback.
    }
  }

  private async reconcile(): Promise<void> {
    if (this.disposed) return;
    for (const taskId of await this.store.listOwnTaskIds()) {
      this.watchTask(taskId);
      const paths = this.store.paths(taskId);
      if (existsSync(paths.result)) await this.processCompletion(taskId);
      else await this.get(taskId).catch(() => undefined);
    }
  }

  private async processCompletion(taskId: string): Promise<void> {
    const paths = this.store.paths(taskId);
    const result = await this.store.readResult(paths);
    if (!result || this.seenCompletions.has(taskId)) return;
    this.seenCompletions.add(taskId);
    const timer = this.timeoutTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.timeoutTimers.delete(taskId);
    const summary = await this.get(taskId);
    if (summary) {
      this.emit("completion", summary);
      this.emit("changed", summary);
    }
  }

  private scheduleTimeout(taskId: string, startedAt: string, timeoutSeconds?: number): void {
    if (timeoutSeconds === undefined) return;
    const remaining = Date.parse(startedAt) + timeoutSeconds * 1000 - Date.now();
    const timer = setTimeout(() => {
      this.terminateWithTimeout(taskId).catch(() => undefined);
    }, Math.max(0, remaining));
    timer.unref();
    this.timeoutTimers.set(taskId, timer);
  }

  private async terminateWithTimeout(taskId: string): Promise<void> {
    const paths = await this.store.findTask(taskId);
    if (!paths) return;
    await this.store.writeCancellation(paths, "timed_out");
    const current = await this.get(taskId);
    if (!current) return;
    await this.backend.kill(current.sessionName).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    const result = await this.store.readResult(paths);
    if (!result) {
      await this.store.writeResult(paths, {
        schemaVersion: 1,
        taskId,
        status: "timed_out",
        exitCode: null,
        signal: null,
        startedAt: current.startedAt,
        endedAt: new Date().toISOString(),
        reason: "timed_out",
      });
    }
    await this.processCompletion(taskId);
  }

  private async restoreTimeout(taskId: string): Promise<void> {
    const paths = this.store.paths(taskId);
    const meta = await this.store.readMeta(paths);
    const result = await this.store.readResult(paths);
    if (meta?.timeoutSeconds !== undefined && meta.startedAt && !result) {
      this.scheduleTimeout(taskId, meta.startedAt, meta.timeoutSeconds);
    }
  }

  private async waitForCompletionEvent(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const done = () => {
        cleanup();
        resolvePromise();
      };
      const aborted = () => {
        cleanup();
        reject(Object.assign(new Error("Operation aborted"), { name: "AbortError" }));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off("completion", done);
        signal?.removeEventListener("abort", aborted);
      };
      const timer = setTimeout(done, timeoutMs);
      this.once("completion", done);
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  private async waitForResult(paths: TaskPaths, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(paths.result)) return true;
      await new Promise((r) => setTimeout(r, 30));
    }
    return existsSync(paths.result);
  }
}
