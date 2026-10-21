import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SubagentBatchTask } from "./types.ts";
import type { ToolResult } from "../tools/types.ts";

type TaskState = "pending" | "running" | "done" | "error" | "blocked";
type AsyncTaskRecord = { label: string; state: TaskState; result?: ToolResult; error?: string };
type PersistedTask = SubagentBatchTask & { state: TaskState; result?: ToolResult; error?: string };
type AsyncJob = {
  id: string;
  createdAt: string;
  tasks: AsyncTaskRecord[];
  definitions?: SubagentBatchTask[];
  maxConcurrency?: number;
  completion: Promise<void>;
};

const jobs = new Map<string, AsyncJob>();
const MAX_JOBS = 100;
const persistenceRoot = path.join(process.env.AGENT_DATA_DIR ?? path.join(os.homedir(), ".mini-agent"), "subagent-jobs");
const writeQueues = new Map<string, Promise<void>>();
let recoveryPromise: Promise<void> | undefined;

function persistencePath(id: string): string { return path.join(persistenceRoot, `${id}.json`); }

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
    await writeFile(temporary, JSON.stringify({ id: job.id, createdAt: job.createdAt, maxConcurrency: job.maxConcurrency, tasks }, null, 2), { encoding: "utf8", mode: 0o600 });
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
          const saved = JSON.parse(await readFile(path.join(persistenceRoot, file), "utf8")) as { id: string; createdAt: string; maxConcurrency?: number; tasks: PersistedTask[] };
          if (!saved.id?.startsWith("saj_") || !Array.isArray(saved.tasks)) continue;
          const definitions = saved.tasks.map(({ state: _state, result: _result, error: _error, ...definition }) => definition);
          const tasks = saved.tasks.map(({ label, state, result, error }) => ({ label, state: state === "running" ? "pending" as const : state, ...(result ? { result } : {}), ...(error && state !== "running" ? { error } : {}) }));
          const job: AsyncJob = { id: saved.id, createdAt: saved.createdAt, tasks, definitions, maxConcurrency: saved.maxConcurrency, completion: Promise.resolve() };
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

export async function submitAsyncBatch(
  tasks: SubagentBatchTask[],
  execute: (task: SubagentBatchTask, dependencyResults: string) => Promise<ToolResult>,
  maxConcurrency = 0,
): Promise<string> {
  await recoverJobs();
  const validationError = validateAsyncDag(tasks);
  if (validationError) throw new Error(validationError);
  while (jobs.size >= MAX_JOBS) jobs.delete(jobs.keys().next().value!);
  const job: AsyncJob = {
    id: `saj_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    tasks: tasks.map(({ label }) => ({ label, state: "pending" })),
    definitions: tasks,
    maxConcurrency,
    completion: Promise.resolve(),
  };
  jobs.set(job.id, job);
  await persist(job);
  const limit = maxConcurrency > 0 ? maxConcurrency : tasks.length;
  job.completion = (async () => {
    const results = new Map<string, string>();
    let active = 0;
    await new Promise<void>((resolve) => {
      const schedule = (): void => {
        let progressed = false;
        for (let i = 0; i < tasks.length && active < limit; i++) {
          const definition = tasks[i]!;
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
          void execute(definition, dependencyContext).then((result) => {
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
            void persist(job);
            schedule();
          });
        }
        if (job.tasks.every((task) => task.state === "done" || task.state === "error" || task.state === "blocked")) resolve();
        else if (!progressed && active === 0) resolve();
      };
      schedule();
    });
  })();
  return job.id;
}

export async function resumeAsyncBatches(
  execute: (task: SubagentBatchTask, dependencyResults: string) => Promise<ToolResult>,
): Promise<void> {
  await recoverJobs();
  for (const job of jobs.values()) {
    if (!job.definitions || job.tasks.every((task) => task.state === "done" || task.state === "error" || task.state === "blocked")) continue;
    if (job.tasks.some((task) => task.state === "running")) continue;
    const results = new Map(job.tasks.flatMap((record) => record.state === "done" && record.result
      ? [[record.label, typeof record.result.content === "string" ? record.result.content : "[complex content]"] as const]
      : []));
    for (let index = 0; index < job.definitions.length; index++) {
      const definition = job.definitions[index]!;
      const record = job.tasks[index]!;
      if (record.state !== "pending") continue;
      const dependencies = definition.dependsOn ?? [];
      if (dependencies.some((label) => ["error", "blocked"].includes(job.tasks.find((task) => task.label === label)?.state ?? ""))) {
        record.state = "blocked";
        record.error = "A dependency did not complete successfully.";
        continue;
      }
      if (!dependencies.every((label) => job.tasks.find((task) => task.label === label)?.state === "done")) continue;
      record.state = "running";
      await persist(job);
      const context = dependencies.map((label) => `Dependency ${label} result:\n${results.get(label) ?? ""}`).join("\n\n");
      try {
        const result = await execute(definition, context);
        record.result = result;
        record.state = result.isError || result.partial ? "error" : "done";
        if (record.state === "done") results.set(definition.label, typeof result.content === "string" ? result.content : "[complex content]");
        else record.error = String(result.content);
      } catch (error) {
        record.state = "error";
        record.error = error instanceof Error ? error.message : String(error);
      }
      await persist(job);
    }
  }
}

export async function readAsyncBatch(jobId: string, includeResults = false): Promise<string> {
  await recoverJobs();
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Unknown subagent job: ${jobId}`);
  if (!includeResults) return serialize(job);
  return JSON.stringify({ ...JSON.parse(serialize(job)), results: job.tasks.map(({ label, state, result, error }) => ({ label, state, ...(result ? { content: result.content, partial: result.partial, isError: result.isError } : {}), ...(error ? { error } : {}) })) }, null, 2);
}

export async function waitAsyncBatch(jobId: string, timeoutMs = 30_000): Promise<string> {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Unknown subagent job: ${jobId}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      job.completion,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, timeoutMs)); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return readAsyncBatch(jobId);
}
