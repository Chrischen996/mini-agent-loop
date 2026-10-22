export type TodoResourceClass =
  | "code"
  | "install"
  | "dependency"
  | "lockfile"
  | "build"
  | "test"
  | "migration"
  | "docs"
  | "unknown";

export type TodoRunnerKind = "subagent" | "bg" | "noop";

export type RunnerTaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "skipped";

export interface RunnerTask {
  todoId: string;
  label: string;
  content: string;
  runner: TodoRunnerKind;
  resourceClass: TodoResourceClass;
  dependsOn: string[];
  model?: string;
  files?: string[];
  status: RunnerTaskStatus;
  error?: string;
  bgTaskId?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface RunnerPlan {
  tasks: RunnerTask[];
  batches: string[][];
  resourceLocks: Record<string, string[]>;
}

export interface ParsedTodosRunArgs {
  parallel: boolean;
  dryRun: boolean;
  resume?: boolean;
  retry?: boolean;
  only?: string[];
  deps?: Record<string, string[]>;
  model?: Record<string, string>;
  files?: Record<string, string[]>;
  maxConcurrency?: number;
  /** Skip the plan-confirmation step; required for actual execution. */
  confirm: boolean;
  raw: string;
}
