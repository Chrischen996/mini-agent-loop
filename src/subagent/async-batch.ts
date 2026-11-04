import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SubagentBatchTask } from "./types.ts";
import type { ToolResult } from "../tools/types.ts";

type TaskState = "pending" | "running" | "done" | "error" | "blocked";
type AsyncTaskRecord = { label: string; state: TaskState; subagentTaskId: string; result?: ToolResult; error?: string };
type PersistedTask = SubagentBatchTask & { state: TaskState; subagentTaskId: string; result?: ToolResult; error?: string };
type AsyncJob = {
  id: string;
  createdAt: string;
  tasks: AsyncTaskRecord[];
  definitions?: SubagentBatchTask[];
  maxConcurrency?: number;
  ownerSessionId?: string;
  workerPid?: number;
  workerOptions?: Record<string, unknown>;
  running?: boolean;
  completion: Promise<void>;
};

const jobs = new Map<string, AsyncJob>();
const MAX_JOBS = 100;
const persistenceRoot = path.join(process.env.AGENT_DATA_DIR ?? path.join(os.homedir(), ".mini-agent"), "subagent-jobs");
const writeQueues = new Map<string, Promise<void>>();
let recoveryPromise: Promise<void> | undefined;

function persistencePath(id: string): string { return path.join(persistenceRoot, `${id}.json`); }

function isProcessAlive(pid: number | undefined): boolean {
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isTerminal(job: AsyncJob): boolean {
  return job.tasks.every((task) => task.state === "done" || task.state === "error" || task.state === "blocked");
}

async function persist(job: AsyncJob): Promise<void> {
  const previous = writeQueues.get(job.id) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(async () => {
    await mkdir(persistenceRoot, { recursive: true, mode: 0o700 });
    const target = persistencePath(job.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const tasks: PersistedTask[] = (job.definitions ?? []).map((definition, index) => ({
      ...definition,
      ...job.tasks[index],
    }));
    await writeFile(temporary, JSON.stringify({ id: job.id, createdAt: job.createdAt, maxConcurrency: job.maxConcurrency, ownerSessionId: job.ownerSessionId, workerPid: job.workerPid, workerOptions: job.workerOptions, tasks }, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  });
  writeQueues.set(job.id, write);
  try { await write; } finally { if (writeQueues.get(job.id) === write) writeQueues.delete(job.id); }
}

async function recoverJobs(): Promise<void> {
  if (!recoveryPromise) recoveryPromise = (async () => {
    try {
      const files = (await readdir(persistenceRoot)).filter((name) => /^saj_[a-f0-9-]+\.json$/i.test(name));
      for (const file of files.slice(-MAX_JOBS)) {
        try {
          const saved = JSON.parse(await readFile(path.join(persistenceRoot, file), "utf8")) as { id: string; createdAt: string; maxConcurrency?: number; ownerSessionId?: string; workerPid?: number; workerOptions?: Record<string, unknown>; tasks: PersistedTask[] };
          if (!saved.id?.startsWith("saj_") || !Array.isArray(saved.tasks)) continue;
          const definitions = saved.tasks.map(({ state: _state, result: _result, error: _error, subagentTaskId: _subagentTaskId, ...definition }) => definition);
          const workerAlive = isProcessAlive(saved.workerPid);
          const tasks = saved.tasks.map(({ label, state, subagentTaskId, result, error }) => ({
            label,
            subagentTaskId,
            state: state === "running" && !workerAlive ? "pending" as const : state,
            ...(result ? { result } : {}),
            ...(error && (state !== "running" || workerAlive) ? { error } : {}),
          }));
          const job: AsyncJob = { id: saved.id, createdAt: saved.createdAt, tasks, definitions, maxConcurrency: saved.maxConcurrency, ownerSessionId: saved.ownerSessionId, ...(workerAlive ? { workerPid: saved.workerPid } : {}), workerOptions: saved.workerOptions, completion: Promise.resolve() };
          jobs.set(job.id, job);
        } catch { /* Ignore corrupt or partially replaced records. */ }
      }
    } catch { /* The store is created lazily when a job is submitted. */ }
  })();
  return recoveryPromise;
}

function serialize(job: AsyncJob): string {
  const states = job.tasks.map(({ label, state, error }) => ({ label, state, ...(error ? { error } : {}) }));
  return JSON.stringify({ jobId: job.id, createdAt: job.createdAt, status: job.tasks.every((t) => t.state === "done" || t.state === "error" || t.state === "blocked") ? "completed" : "running", tasks: states }, null, 2);
}

export function validateAsyncDag(tasks: SubagentBatchTask[]): string | undefined {
  if (!tasks.length) return "No tasks provided for batch execution.";
  const labels = new Set<string>();
  for (const task of tasks) {
    if (!task.label || labels.has(task.label)) return `Task labels must be non-empty and unique: ${task.label}`;
    labels.add(task.label);
  }
  const graph = new Map(tasks.map((task) => [task.label, task.dependsOn ?? []]));
  for (const [label, dependencies] of graph) {
    for (const dependency of dependencies) if (!graph.has(dependency)) return `Task ${label} depends on unknown task ${dependency}.`;
    if (dependencies.includes(label)) return `Task ${label} cannot depend on itself.`;
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (label: string): boolean => {
    if (visiting.has(label)) return false;
    if (visited.has(label)) return true;
    visiting.add(label);
    for (const dependency of graph.get(label) ?? []) if (!visit(dependency)) return false;
    visiting.delete(label);
    visited.add(label);
    return true;
  };
  return [...graph.keys()].every(visit) ? undefined : "Task dependencies contain a cycle.";
}

function startJob(job: AsyncJob, execute: (task: SubagentBatchTask, dependencyResults: string, subagentTaskId: string) => Promise<ToolResult>): void {
  job.running = true;
  const definitions = job.definitions ?? [];
  const limit = job.maxConcurrency && job.maxConcurrency > 0 ? job.maxConcurrency : definitions.length;
  job.completion = (async () => {
    const results = new Map(job.tasks.flatMap((record) => record.state === "done" && record.result
      ? [[record.label, typeof record.result.content === "string" ? record.result.content : "[complex content]"] as const]
      : []));
    let active = 0;
    await new Promise<void>((resolve) => {
      const schedule = (): void => {
        let progressed = false;
        for (let i = 0; i < definitions.length && active < limit; i++) {
          const definition = definitions[i]!;
          const record = job.tasks[i]!;
          if (record.state !== "pending") continue;
          const dependencies = definition.dependsOn ?? [];
          if (dependencies.some((name) => job.tasks.find((entry) => entry.label === name)?.state === "error" || job.tasks.find((entry) => entry.label === name)?.state === "blocked")) {
            record.state = "blocked";
            record.error = "A dependency did not complete successfully.";
            progressed = true;
            void persist(job);
            continue;
          }
          if (!dependencies.every((name) => job.tasks.find((entry) => entry.label === name)?.state === "done")) continue;
          record.state = "running";
          active++;
          progressed = true;
          void persist(job);
          const dependencyContext = dependencies.map((name) => `Dependency ${name} result:\n${results.get(name) ?? ""}`).join("\n\n");
          void execute(definition, dependencyContext, record.subagentTaskId).then((result) => {
            record.result = result;
            if (result.isError || result.partial) {
              record.state = "error";
              record.error = String(result.content);
            } else {
              record.state = "done";
              results.set(definition.label, typeof result.content === "string" ? result.content : "[complex content]");
            }
          }, (error: unknown) => {
            record.state = "error";
            record.error = error instanceof Error ? error.message : String(error);
          }).finally(() => {
            active--;
            void persist(job).finally(schedule);
          });
        }
        if (isTerminal(job)) resolve();
        else if (!progressed && active === 0) resolve();
      };
      schedule();
    });
  })().finally(async () => {
    job.running = false;
    if (isTerminal(job)) {
      job.workerPid = undefined;
      await persist(job);
    }
  });
}

export async function submitAsyncBatch(
  tasks: SubagentBatchTask[],
  execute: (task: SubagentBatchTask, dependencyResults: string, subagentTaskId: string) => Promise<ToolResult>,
  maxConcurrency = 0,
  /**
   * Pre-launch panel check (Grok Build agent_budget style): given the total
   * number of sub-agent calls this panel will make, return an error message
   * to reject the whole panel before any task starts, or undefined to accept.
   */
  precheckCalls?: (taskCount: number) => string | undefined,
  options: { deferExecution?: boolean; ownerSessionId?: string; workerOptions?: Record<string, unknown> } = {},
): Promise<string> {
  await recoverJobs();
  const validationError = validateAsyncDag(tasks);
  if (validationError) throw new Error(validationError);
  const precheckError = precheckCalls?.(tasks.length);
  if (precheckError) throw new Error(precheckError);
  while (jobs.size >= MAX_JOBS) jobs.delete(jobs.keys().next().value!);
  const job: AsyncJob = {
    id: `saj_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    tasks: tasks.map(({ label }) => ({ label, state: "pending", subagentTaskId: `sub_${randomUUID()}` })),
    definitions: tasks.map((task) => ({ ...task })),
    maxConcurrency,
    ...(options.ownerSessionId ? { ownerSessionId: options.ownerSessionId } : {}),
    ...(options.workerOptions ? { workerOptions: structuredClone(options.workerOptions) } : {}),
    completion: Promise.resolve(),
  };
  jobs.set(job.id, job);
  await persist(job);
  if (!options.deferExecution) startJob(job, execute);
  return job.id;
}

export async function resumeAsyncBatches(
  execute: (task: SubagentBatchTask, dependencyResults: string, subagentTaskId: string) => Promise<ToolResult>,
  jobId?: string,
): Promise<void> {
  await recoverJobs();
  for (const job of jobs.values()) {
    if (jobId && job.id !== jobId) continue;
    if (!job.definitions || isTerminal(job)) continue;
    if (job.running) continue;
    if (job.workerPid && isProcessAlive(job.workerPid) && job.workerPid !== process.pid) continue;
    job.workerPid = process.pid;
    for (const task of job.tasks) if (task.state === "running") task.state = "pending";
    await persist(job);
    startJob(job, execute);
    await job.completion;
  }
}

async function refreshPersistedJob(job: AsyncJob): Promise<void> {
  const saved = await readFile(persistencePath(job.id), "utf8")
    .then((value) => JSON.parse(value) as { workerPid?: number; ownerSessionId?: string; workerOptions?: Record<string, unknown>; tasks?: PersistedTask[] })
    .catch(() => undefined);
  if (!saved?.tasks || saved.tasks.length !== job.tasks.length) return;
  job.workerPid = saved.workerPid;
  job.ownerSessionId = saved.ownerSessionId;
  job.workerOptions = saved.workerOptions;
  for (let index = 0; index < saved.tasks.length; index++) {
    const next = saved.tasks[index]!;
    Object.assign(job.tasks[index]!, {
      label: next.label,
      state: next.state,
      subagentTaskId: next.subagentTaskId,
      result: next.result,
      error: next.error,
    });
  }
}

export async function claimAsyncBatchWorker(jobId: string): Promise<boolean> {
  await recoverJobs();
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Unknown subagent job: ${jobId}`);
  const lockPath = `${persistencePath(jobId)}.worker.lock`;
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
      if (Date.now() >= deadline) throw new Error(`Timed out claiming async batch worker ${jobId}.`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    await refreshPersistedJob(job);
    if (isTerminal(job) || (job.workerPid && isProcessAlive(job.workerPid))) return false;
    job.workerPid = process.pid;
    await persist(job);
    return true;
  } finally {
    await lock.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function pendingAsyncBatchJobs(ownerSessionId: string): Promise<string[]> {
  await recoverJobs();
  const pending: string[] = [];
  for (const job of jobs.values()) {
    if (job.ownerSessionId !== ownerSessionId) continue;
    await refreshPersistedJob(job);
    if (!isTerminal(job) && !isProcessAlive(job.workerPid)) pending.push(job.id);
  }
  return pending;
}

export async function getAsyncBatchWorkerOptions(jobId: string): Promise<Record<string, unknown> | undefined> {
  await recoverJobs();
  const job = jobs.get(jobId);
  if (!job) return undefined;
  await refreshPersistedJob(job);
  return job.workerOptions ? structuredClone(job.workerOptions) : undefined;
}

export async function setAsyncBatchWorkerPid(jobId: string, workerPid?: number): Promise<void> {
  await recoverJobs();
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Unknown subagent job: ${jobId}`);
  job.workerPid = workerPid;
  await persist(job);
}

export async function readAsyncBatch(jobId: string, includeResults = false, ownerSessionId?: string): Promise<string> {
  await recoverJobs();
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Unknown subagent job: ${jobId}`);
  if (ownerSessionId !== undefined && job.ownerSessionId !== ownerSessionId) throw new Error(`Unknown subagent job: ${jobId}`);
  if (job.workerPid && job.workerPid !== process.pid) await refreshPersistedJob(job);
  if (!includeResults) return serialize(job);
  return JSON.stringify({ ...JSON.parse(serialize(job)), results: job.tasks.map(({ label, state, result, error }) => ({ label, state, ...(result ? { content: result.content, partial: result.partial, isError: result.isError } : {}), ...(error ? { error } : {}) })) }, null, 2);
}

export async function waitAsyncBatch(jobId: string, timeoutMs = 30_000, ownerSessionId?: string): Promise<string> {
  await recoverJobs();
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Unknown subagent job: ${jobId}`);
  if (ownerSessionId !== undefined && job.ownerSessionId !== ownerSessionId) throw new Error(`Unknown subagent job: ${jobId}`);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (!isTerminal(job) && Date.now() < deadline) {
    if (job.workerPid && job.workerPid !== process.pid) await refreshPersistedJob(job);
    if (isTerminal(job)) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
  }
  return readAsyncBatch(jobId, false, ownerSessionId);
}
