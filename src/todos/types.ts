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
  /** Optional isolated working directory assigned by the execution layer. */
  cwd?: string;
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
  /** Accepted by the parser for non-TUI callers; TUI still requires A/Enter confirmation. */
  confirm: boolean;
  /** Worktree isolation is opt-in; shared checkout remains the default. */
  worktree?: boolean;
  raw: string;
}
