import type { RunnerTask, TodoResourceClass } from "./types.ts";

/**
 * Per-workspace mutation locks. A task holding a lock may never run
 * concurrently with another task holding the same lock: the runner serializes
 * every task of a locked class into solo batches and holds a promise-chained
 * mutex across its full bg_start → wait lifetime.
 */
export const WORKSPACE_MUTATION_LOCKS = ["deps", "build", "db"] as const;
export type WorkspaceMutationLock = (typeof WORKSPACE_MUTATION_LOCKS)[number];

/** Resource classes that must be serialized behind a workspace mutation lock. */
const LOCK_CLASSES: ReadonlySet<TodoResourceClass> = new Set([
  "install",
  "dependency",
  "lockfile",
  "build",
  "test",
  "migration",
]);

const INSTALL_RE = /npm install|pnpm install|yarn install|bun install|npm ci|pnpm ci|yarn (add|remove)|install (dependencies?|deps)|add (a )?dep(s|endency)|package-manager|lockfile|package-lock|pnpm-lock|yarn\.lock/i;
const MIGRATION_RE = /migrate|migration|alter (table|database)|db (upgrade|schema)|flyway|alembic/i;
const BUILD_RE = /(^|\s|\/)build|tsc( |\b)|vite build|webpack|rollup|bundle/i;
const TEST_RE = /(^|\s|\/)(test|tests|spec|specs|e2e|integration test|unit test)\b|vitest|jest|pytest|go test|lint/i;
const DOCS_RE = /(^|\s|\/)(docs?|readme|documentation|comment)\b/i;

/**
 * Classify a todo's resource class from its content and the files the user
 * restricted it to (--files). Order matters: install beats everything, then
 * migration, build, test, docs; source-file todos are code.
 */
export function classifyTodo(content: string, files?: string[]): TodoResourceClass {
  const text = content;
  if (INSTALL_RE.test(text)) {
    // Install commands and lockfile drift both mutate the dependency graph.
    return /lockfile|package-lock|pnpm-lock|yarn\.lock/i.test(text) ? "lockfile" : "install";
  }
  if (MIGRATION_RE.test(text)) return "migration";
  if (BUILD_RE.test(text)) return "build";
  if (TEST_RE.test(text)) return "test";
  if (DOCS_RE.test(text)) return "docs";
  if (files && files.length > 0) return "code";
  return "unknown";
}

/** Compatibility alias used by the DAG builder. */
export function classifyResourceClass(content: string, files?: string[]): TodoResourceClass {
  return classifyTodo(content, files);
}

/** Map a resource class to the runner that owns it. */
export function resolveRunnerForTask(resourceClass: TodoResourceClass): RunnerTask["runner"] {
  switch (resourceClass) {
    case "install":
    case "dependency":
    case "lockfile":
    case "build":
    case "test":
    case "migration":
      return "bg";
    case "code":
    case "docs":
    case "unknown":
      return "subagent";
  }
}

/** Which workspace mutation lock a resource class must hold (null = lock-free). */
export function lockFor(resourceClass: TodoResourceClass): WorkspaceMutationLock | null {
  switch (resourceClass) {
    case "install":
    case "dependency":
    case "lockfile":
      return "deps";
    case "build":
    case "test":
      return "build";
    case "migration":
      return "db";
    default:
      return null;
  }
}

export function isLockedClass(resourceClass: TodoResourceClass): boolean {
  return LOCK_CLASSES.has(resourceClass);
}

/**
 * Lock groups over a task list: each entry is one solo batch position the
 * runner must reserve for every task holding that lock. Tasks of the same
 * lock never interleave with each other or with unrelated locked tasks.
 */
export function lockGroupsFor(tasks: readonly RunnerTask[]): Array<{
  lock: WorkspaceMutationLock;
  taskLabels: string[];
}> {
  const groups = new Map<WorkspaceMutationLock, string[]>();
  for (const task of tasks) {
    const lock = lockFor(task.resourceClass);
    if (!lock) continue;
    const labels = groups.get(lock) ?? [];
    labels.push(task.label);
    groups.set(lock, labels);
  }
  return [...groups.entries()].map(([lock, taskLabels]) => ({ lock, taskLabels }));
}
