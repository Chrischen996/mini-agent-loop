import { existsSync, linkSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface TaskMeta {
  schemaVersion: 1;
  taskId: string;
  name: string;
  command: string;
  cwd: string;
  shell: string;
  status: "starting" | "running";
  createdAt: string;
  startedAt?: string;
  timeoutSeconds?: number;
  notifyOnCompletion: boolean;
  notifiedAt?: string;
}

export interface TaskResult {
  schemaVersion: 1;
  taskId: string;
  status: "completed" | "failed" | "cancelled" | "timed_out" | "interrupted";
  exitCode: number | null;
  signal: string | null;
  startedAt?: string;
  endedAt: string;
  reason?: string;
}

export interface TaskPaths {
  dir: string;
  meta: string;
  log: string;
  result: string;
  gate: string;
  cancel: string;
}

export class BgTaskStore {
  readonly root: string;
  readonly instanceRoot: string;

  constructor(projectCwd: string, instanceId: string) {
    this.root = join(projectCwd, ".bg-tasks", "instances");
    this.instanceRoot = join(this.root, instanceId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700).catch(() => undefined);
  }

  paths(taskId: string): TaskPaths {
    const dir = join(this.instanceRoot, taskId);
    return {
      dir,
      meta: join(dir, "meta.json"),
      log: join(dir, "output.log"),
      result: join(dir, "result.json"),
      gate: join(dir, "start.signal"),
      cancel: join(dir, "cancel.json"),
    };
  }

  async createTask(meta: TaskMeta): Promise<TaskPaths> {
    const paths = this.paths(meta.taskId);
    await mkdir(this.instanceRoot, { recursive: true, mode: 0o700 });
    await chmod(this.instanceRoot, 0o700).catch(() => undefined);
    await mkdir(paths.dir, { recursive: false, mode: 0o700 });
    await this.writeJson(paths.meta, meta);
    const handle = await open(paths.log, "wx", 0o600);
    await handle.close();
    return paths;
  }

  async readMeta(paths: TaskPaths): Promise<TaskMeta | undefined> {
    return readJson<TaskMeta>(paths.meta);
  }

  async readResult(paths: TaskPaths): Promise<TaskResult | undefined> {
    return readJson<TaskResult>(paths.result);
  }

  async updateMeta(paths: TaskPaths, update: (meta: TaskMeta) => TaskMeta): Promise<TaskMeta> {
    const current = await this.readMeta(paths);
    if (!current) throw new Error("Missing task metadata");
    const next = update(current);
    await this.writeJson(paths.meta, next);
    return next;
  }

  async signalStart(paths: TaskPaths): Promise<void> {
    await writeFile(paths.gate, "start\n", { mode: 0o600, flag: "wx" });
  }

  async writeCancellation(paths: TaskPaths, reason: "cancelled" | "timed_out" | "quit"): Promise<void> {
    if (existsSync(paths.cancel)) return;
    const temp = `${paths.cancel}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify({ reason, requestedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    try {
      linkSync(temp, paths.cancel);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      unlinkSync(temp);
    }
  }

  async writeResult(paths: TaskPaths, result: TaskResult): Promise<void> {
    if (existsSync(paths.result)) return;
    const temp = `${paths.result}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    try {
      linkSync(temp, paths.result);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      unlinkSync(temp);
    }
  }

  async findTask(taskId: string): Promise<TaskPaths | undefined> {
    const paths = this.paths(taskId);
    if (existsSync(paths.meta)) return paths;
    return undefined;
  }

  async listOwnTaskIds(): Promise<string[]> {
    return listDirectories(this.instanceRoot);
  }

  async removeTask(taskId: string): Promise<void> {
    const paths = this.paths(taskId);
    await rm(paths.dir, { recursive: true, force: true });
    await rmdir(dirname(paths.dir)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
    });
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
    await chmod(path, 0o600).catch(() => undefined);
  }
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function listDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
