import { EventEmitter } from "node:events";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { BgTaskStore, type TaskMeta, type TaskPaths, type TaskResult } from "./store.js";
import { BgTmuxBackend } from "./tmux.js";
import { BgProcessBackend } from "./process.js";
import type { BgBackendKind, BgTaskBackend } from "./backend.js";
import { resolveWorkspacePath } from "../workspace.ts";

export type BgBackendMode = "auto" | BgBackendKind;

export function stableBgTaskInstanceId(projectCwd: string): string {
  return `project_${createHash("sha256").update(projectCwd).digest("hex").slice(0, 20)}`;
}

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
  backend: BgBackendKind;
  pid?: number;
  attachCommand?: string;
  reason?: string;
  tags?: string[];
}

export interface LogChunk {
  taskId: string;
  text: string;
  offset: number;
  nextOffset: number;
  endOfLog: boolean;
}

export interface LogSearchOptions {
  search?: string;
  context?: number;
  level?: "debug" | "info" | "warn" | "error";
  reverse?: boolean;
}

export interface LogSearchResult {
  taskId: string;
  matches: string[];
  matchCount: number;
  truncated: boolean;
}

export interface StartTaskInput {
  command?: string;
  template?: string;
  cwd?: string;
  name?: string;
  timeoutSeconds?: number;
  depends_on?: string[];
  strategy?: "all" | "any";
  tags?: string[];
  priority?: "high" | "normal" | "low";
  maxConcurrent?: number;
  cpuLimit?: number;
  memoryLimit?: string;
}

export interface SnapshotInput {
  taskId: string;
  include?: string[];
}

export interface ReplayInput {
  snapshot: string;
}

export interface SendTaskInput {
  text?: string;
  enter?: boolean;
  key?: "ctrl_c" | "ctrl_d" | "ctrl_z" | "up" | "down" | "left" | "right";
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

function keyToTmuxKey(key: SendTaskInput["key"]): string {
  switch (key) {
    case "ctrl_c": return "C-c";
    case "ctrl_d": return "C-d";
    case "ctrl_z": return "C-z";
    case "up": return "Up";
    case "down": return "Down";
    case "left": return "Left";
    case "right": return "Right";
    default: throw new Error(`Unsupported send key: ${String(key)}`);
  }
}

function defaultRunnerPath(): string {
  const javascriptRunner = fileURLToPath(new URL("./runner.js", import.meta.url));
  if (existsSync(javascriptRunner)) return javascriptRunner;
  const typescriptRunner = fileURLToPath(new URL("./runner.ts", import.meta.url));
  return existsSync(typescriptRunner) ? typescriptRunner : javascriptRunner;
}

export class BgTaskManager extends EventEmitter {
  readonly store: BgTaskStore;
  backend: BgTaskBackend;
  private readonly tmuxBackend: BgTmuxBackend;
  private readonly processBackend: BgProcessBackend;
  private readonly runnerPath: string;
  private readonly backendMode: BgBackendMode;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timeoutTimers = new Map<string, NodeJS.Timeout>();
  private readonly seenCompletions = new Set<string>();
  private readonly activeWaiters = new Map<string, number>();
  private reconciliationTimer?: NodeJS.Timeout;
  private cleanupHandler?: () => void;
  private healthCheckTimer?: NodeJS.Timeout;
  private disposed = false;
  private initialized = false;
  private initialization?: Promise<void>;

  constructor(
    readonly projectCwd: string,
    readonly instanceId: string,
    runnerPath?: string,
    options: { backend?: BgBackendMode } = {},
  ) {
    super();
    this.store = new BgTaskStore(projectCwd, instanceId);
    this.runnerPath = runnerPath ?? defaultRunnerPath();
    this.tmuxBackend = new BgTmuxBackend(
      `pi-bg-${instanceId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 56)}`,
      this.runnerPath,
    );
    this.processBackend = new BgProcessBackend(this.runnerPath);
    const configuredBackend = options.backend ?? process.env.MINI_AGENT_BG_BACKEND;
    this.backendMode = configuredBackend === "tmux" || configuredBackend === "process" ? configuredBackend : "auto";
    this.backend = this.tmuxBackend;

    this.cleanupHandler = () => {
      this.dispose();
    };
    process.once("exit", this.cleanupHandler);
    process.once("SIGINT", this.cleanupHandler);
    process.once("SIGTERM", this.cleanupHandler);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialization ??= this.initializeOnce();
    try {
      await this.initialization;
      this.initialized = true;
    } catch (error) {
      this.initialization = undefined;
      throw error;
    }
  }

  private async initializeOnce(): Promise<void> {
    if (this.backendMode === "process") {
      this.backend = this.processBackend;
    } else {
      try {
        await this.tmuxBackend.assertAvailable();
        this.backend = this.tmuxBackend;
      } catch (error) {
        if (this.backendMode === "tmux") throw error;
        this.backend = this.processBackend;
      }
    }
    await this.backend.assertAvailable();
    await this.store.initialize();
    await this.recoverOrphanedTasks();
    for (const taskId of await this.store.listOwnTaskIds()) {
      this.watchTask(taskId);
      await this.restoreTimeout(taskId);
    }
    await this.reconcile();
    this.reconciliationTimer = setInterval(() => void this.reconcile(), 1000);
    this.reconciliationTimer.unref();
    this.healthCheckTimer = setInterval(async () => {
      for (const taskId of await this.store.listOwnTaskIds()) {
        const paths = await this.store.findTask(taskId);
        if (!paths) continue;
        const meta = await this.store.readMeta(paths);
        if (meta?.status === "running" && meta.pid) {
          const alive = await this.isProcessAlive(meta.pid);
          if (!alive) await this.handleCrash(taskId);
        }
      }
    }, 5000);
    this.healthCheckTimer.unref();
  }

  async start(input: StartTaskInput): Promise<BgTaskSummary> {
    await this.initialize();
    if (input.depends_on && input.depends_on.length > 0) {
      await this.wait(input.depends_on, input.strategy ?? "all");
    }
    const template = input.template ? await (async () => {
      const templates = await this.readTemplates();
      const t = templates[input.template!];
      if (!t) throw new Error(`Template not found: ${input.template}`);
      return t;
    })() : undefined;
    const command = input.command ?? template?.command ?? "";
    if (!command.trim()) throw new Error("command or template must be provided");
    const resolvedCwd = await resolveWorkspacePath(this.projectCwd, input.cwd ?? "");
    if (!resolvedCwd.ok) throw new Error(resolvedCwd.error);
    const taskId = `bg_${randomUUID().replace(/-/g, "")}`;
    const sessionName = `pi-${taskId}`;
    const meta: TaskMeta = {
      schemaVersion: 1,
      taskId,
      name: input.name?.trim() || template?.name || command.trim().slice(0, 80),
      command,
      cwd: resolvedCwd.realTarget,
      shell: process.env.SHELL || "/bin/sh",
      status: "starting",
      createdAt: new Date().toISOString(),
      notifyOnCompletion: true,
      backend: this.backend.kind,
      sessionName,
      socketName: this.backend.socketName,
      instanceId: this.instanceId,
      ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
      tags: Array.isArray(input.tags) ? input.tags : undefined,
    };
    const paths = await this.store.createTask(meta);
    let runnerPid: number | undefined;
    try {
      const started = await this.backend.start(sessionName, meta.cwd, paths.dir, paths.log);
      runnerPid = started.pid;
      await this.backend.pipePane(sessionName, paths.log);
      const startedAt = new Date().toISOString();
      await this.store.updateMeta(paths, (current) => ({
        ...current,
        status: "running",
        startedAt,
        ...(runnerPid !== undefined ? { pid: runnerPid } : {}),
      }));
      await this.store.signalStart(paths);
      this.watchTask(taskId);
      this.scheduleTimeout(taskId, startedAt, input.timeoutSeconds);
      const summary = await this.get(taskId);
      if (!summary) throw new Error("Task start returned no summary");
      this.emit("changed", summary);
      return summary;
    } catch (error) {
      await this.backend.kill(sessionName, runnerPid, true, paths.dir).catch(() => undefined);
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

  private async recoverOrphanedTasks() {
    const ids = await this.store.listOwnTaskIds();
    for (const taskId of ids) {
      const paths = await this.store.findTask(taskId);
      if (!paths) continue;
      const meta = await this.store.readMeta(paths);
      if (meta?.status === "running" && meta.instanceId !== this.instanceId) {
        if (meta.restartable && (meta.currentRetry ?? 0) < (meta.maxRetries ?? 3)) {
          await this.start({ command: meta.command, name: meta.name, cwd: meta.cwd });
        }
      }
    }
  }

  private async handleCrash(taskId: string) {
    const paths = await this.store.findTask(taskId);
    if (!paths) return;
    await this.store.updateMeta(paths, (meta) => ({
      ...meta,
      status: "crashed",
      lastCrashReason: `pid ${meta.pid} dead`,
    }));
    const meta = await this.store.readMeta(paths);
    if (meta?.restartable && (meta.currentRetry ?? 0) < (meta.maxRetries ?? 3)) {
      await this.store.updateMeta(paths, (m) => ({ ...m, currentRetry: (m.currentRetry ?? 0) + 1 }));
      await this.start({ command: meta.command, name: meta.name, cwd: meta.cwd });
    }
  }

  private async isProcessAlive(pid?: number): Promise<boolean> {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async snapshot(input: SnapshotInput): Promise<{ snapshotPath: string }> {
    const task = await this.get(input.taskId);
    if (!task) throw new Error(`Task not found: ${input.taskId}`);
    const snapshotsDir = this.store.instanceRoot;
    const snapshotPath = `${snapshotsDir}/snapshots/${task.taskId}_${Date.now()}.json`;
    const snapshot = {
      taskId: task.taskId,
      command: task.command,
      cwd: task.cwd,
      exitCode: task.exitCode,
      status: task.status,
      tags: task.tags,
      timestamp: new Date().toISOString(),
    };
    await mkdir(snapshotsDir, { recursive: true });
    await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2));
    return { snapshotPath };
  }

  async replay(input: ReplayInput): Promise<BgTaskSummary> {
    const raw = await readFile(input.snapshot, "utf8");
    const snapshot = JSON.parse(raw);
    return this.start({ command: snapshot.command, name: snapshot.name, cwd: snapshot.cwd, tags: snapshot.tags });
  }

  async expandTemplate(template: string): Promise<string> {
    const templates = await this.readTemplates();
    const t = templates[template];
    if (!t) throw new Error(`Template not found: ${template}`);
    return t.command;
  }

  async readTemplates(): Promise<Record<string, { command: string; name?: string; cwd?: string; timeout?: number; tags?: string[] }>> {
    const templatesPath = `${this.store.instanceRoot}/../templates.json`;
    try {
      const raw = await readFile(templatesPath, "utf8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  async searchLogs(taskId: string, options: LogSearchOptions = {}): Promise<LogSearchResult> {
    const paths = await this.store.findTask(taskId);
    if (!paths) throw new Error(`Task not found: ${taskId}`);
    const content = await readFile(paths.log, "utf8");
    const lines = content.split("\n");
    const { search, context = 0, level, reverse } = options;
    const matches: string[] = [];
    const targetLevel = level === "debug" ? /debug/i : level === "info" ? /info/i : level === "warn" ? /warn/i : level === "error" ? /error/i : null;
    for (let i = 0; i < lines.length; i++) {
      if (search && !lines[i].toLowerCase().includes(search.toLowerCase())) continue;
      if (targetLevel && !targetLevel.test(lines[i])) continue;
      const start = Math.max(0, i - context);
      const end = Math.min(lines.length, i + context + 1);
      matches.push(lines.slice(start, end).join("\n"));
    }
    if (reverse) matches.reverse();
    return { taskId, matches, matchCount: matches.length, truncated: false };
  }

  async get(taskId: string): Promise<BgTaskSummary | undefined> {
    const paths = await this.store.findTask(taskId);
    if (!paths) return undefined;
    const meta = await this.store.readMeta(paths);
    if (!meta) return undefined;
    const result = await this.store.readResult(paths);
    const taskBackend = this.backendForMeta(meta);
    const sessionName = meta.sessionName ?? `pi-${taskId}`;
    const pid = meta.pid;
    let status: string = result?.status ?? meta.status;
    if (!result) {
      if (!(await taskBackend.hasSession(sessionName, pid, paths.dir))) {
        const interrupted: TaskResult = {
          schemaVersion: 1,
          taskId,
          status: "interrupted",
          exitCode: null,
          signal: null,
          startedAt: meta.startedAt,
          endedAt: new Date().toISOString(),
          reason: `${meta.backend ?? "tmux"} task disappeared without a result`,
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
      ownedByCurrentInstance: !meta.instanceId || meta.instanceId === this.instanceId,
      sessionName,
      socketName: meta.socketName ?? taskBackend.socketName,
      logPath: paths.log,
      backend: meta.backend ?? "tmux",
      pid,
      attachCommand: finalResult || taskBackend.kind !== "tmux" ? undefined : (taskBackend as BgTmuxBackend).attachCommand(sessionName),
      reason: finalResult?.reason,
      tags: meta.tags,
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
    const taskBackend = this.backendForMeta(meta);
    const sessionName = meta.sessionName ?? `pi-${taskId}`;
    if (!(await taskBackend.hasSession(sessionName, meta.pid, paths.dir))) throw new Error(`Task is not running: ${taskId}`);
    const raw = await taskBackend.capturePane(sessionName, lines, paths.log);
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
    if (input.text === undefined && !input.enter && input.key === undefined) throw new Error("Provide text, enter, or key");
    const paths = await this.store.findTask(taskId);
    const meta = paths ? await this.store.readMeta(paths) : undefined;
    if (!meta) throw new Error(`Task metadata is missing: ${taskId}`);
    const taskBackend = this.backendForMeta(meta);
    if (taskBackend.kind === "process" && (input.text !== undefined || input.enter || input.key !== undefined)) {
      throw new Error(
        "Interactive input (bg_send) requires a tmux-backed task. " +
        "Restart the task with MINI_AGENT_BG_BACKEND=tmux, or use process backend only for non-interactive tasks."
      );
    }
    if (input.text !== undefined) await taskBackend.sendLiteral(summary.sessionName, input.text);
    if (input.enter) await taskBackend.sendKey(summary.sessionName, "Enter");
    if (input.key) await taskBackend.sendKey(summary.sessionName, keyToTmuxKey(input.key));
    return summary;
  }

  async terminate(taskId: string, force = false): Promise<BgTaskSummary> {
    const paths = await this.store.findTask(taskId);
    if (!paths) throw new Error(`Task not found: ${taskId}`);
    const current = await this.get(taskId);
    if (!current) throw new Error(`Task not found: ${taskId}`);
    if (isTerminalStatus(current.status)) return current;
    const meta = await this.store.readMeta(paths);
    if (!meta) throw new Error(`Task metadata is missing: ${taskId}`);
    const taskBackend = this.backendForMeta(meta);
    await this.store.writeCancellation(paths, "cancelled");
    if (!force && taskBackend.kind === "tmux" && (await taskBackend.hasSession(current.sessionName, current.pid, paths.dir))) {
      await taskBackend.sendKey(current.sessionName, "C-c").catch(() => undefined);
      const ended = await this.waitForResult(paths, 1500);
      if (ended) {
        await this.processCompletion(taskId);
        return (await this.get(taskId)) ?? current;
      }
    }
    await taskBackend.kill(current.sessionName, current.pid, force, paths.dir).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    const result = await this.store.readResult(paths);
    if (!result) {
      await this.store.writeResult(paths, {
        schemaVersion: 1,
        taskId,
        status: "cancelled",
        exitCode: null,
        signal: force ? "SIGKILL" : taskBackend.kind === "process" ? "SIGTERM" : "SIGHUP",
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
    this.backend.dispose();
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
    const meta = await this.store.readMeta(paths);
    const taskBackend = meta ? this.backendForMeta(meta) : this.backend;
    await taskBackend.kill(current.sessionName, current.pid, true, paths.dir).catch(() => undefined);
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

  private backendForMeta(meta: TaskMeta): BgTaskBackend {
    if (meta.backend === "process") return this.processBackend;
    if (meta.backend === "tmux") {
      if (!meta.socketName || meta.socketName === this.tmuxBackend.socketName) return this.tmuxBackend;
      return new BgTmuxBackend(meta.socketName, this.runnerPath);
    }
    return this.backend;
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
