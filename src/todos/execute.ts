/**
 * Execution strategy for one todo-runner task.
 *
 * `subagent` tasks run through the subagent tool; `bg` tasks map to a
 * workspace command executed through BgTaskManager.
 */
export type BgTaskCommand = {
  kind: "bg";
  command: string;
  timeoutSeconds?: number;
  tags?: string[];
};

export type SubagentTaskCommand = {
  kind: "subagent";
  label: string;
  task: string;
  profile?: string;
  model?: string;
  cwd?: string;
};

export type RunnerTaskPlan = SubagentTaskCommand | BgTaskCommand;

/**
 * Map a runner task to a concrete plan. Shared-workspace commands must be
 * explicitly supplied in the Todo text (for example `cmd: pnpm test`).
 * We never infer a command such as `npm install` from a vague task label.
 */
export function planRunnerTask(
  task: import("./types.ts").RunnerTask,
  detectCommands?: BgCommandDetector,
): RunnerTaskPlan {
  if (task.runner === "bg") {
    const explicitCommand = detectCommands?.(task) ?? commandFromTodo(task.content);
    if (!explicitCommand) {
      throw new Error(`Todo "${task.label}" needs an explicit command (use: cmd: pnpm test)`);
    }
    return {
      kind: "bg",
      command: parseBgCommand(task, explicitCommand),
      timeoutSeconds: 600,
      tags: ["todo-runner", task.resourceClass],
    };
  }
  return {
    kind: "subagent",
    label: task.label,
    task: subagentPromptFor(task),
    profile: "coder",
    ...(task.model ? { model: task.model } : {}),
    ...(task.cwd ? { cwd: task.cwd } : {}),
  };
}

export function defaultBgCommand(task: import("./types.ts").RunnerTask): string {
  const explicit = commandFromTodo(task.content);
  if (explicit) return explicit;
  const defaults: Partial<Record<import("./types.ts").TodoResourceClass, string>> = {
    install: "npm install",
    dependency: "npm install",
    lockfile: "npm install",
    build: "npm run build",
    test: "npm test",
  };
  return defaults[task.resourceClass] ?? "";
}

function commandFromTodo(content: string): string | undefined {
  const match = /(?:^|\s)cmd:\s*([^\n\r]+)/i.exec(content);
  const command = match?.[1]?.trim();
  return command || undefined;
}

export function subagentPromptFor(task: import("./types.ts").RunnerTask): string {
  const lines = [
    `Complete this task: ${task.content}`,
    "Do not report success unless the task is actually complete and required checks pass.",
    "Return exactly one final JSON object wrapped in <todo-result>...</todo-result> with fields:",
    '{"status":"completed"|"failed"|"blocked","summary":"...","changedFiles":["..."],"checks":[{"command":"...","status":"passed"|"failed"|"not_run","output":"..."}],"error":"..."}',
    "If you cannot verify the changes, set status to failed; never claim checks passed unless you ran them.",
  ];
  if (task.cwd) lines.push(`Work only in this isolated worktree directory: ${task.cwd}.`);
  if (task.dependsOn.length > 0) {
    lines.push(`It depends on already-completed tasks: ${task.dependsOn.join(", ")}.`);
  }
  if (task.files && task.files.length > 0) {
    lines.push(`Only modify these files: ${task.files.join(", ")}.`);
  }
  lines.push("Report a concise summary of what you changed and why.");
  return lines.join("\n");
}

/** Override the default bg command per task (e.g. from package.json scripts). */
export type BgCommandDetector = (task: import("./types.ts").RunnerTask) => string | undefined;

export type TaskExecution = {
  ok: boolean;
  summary?: string;
  error?: string;
  changedFiles?: string[];
  checks?: Array<{ command: string; status: "passed" | "failed" | "not_run"; output?: string }>;
};

/** Parse and validate the structured completion receipt required from workers. */
export function parseSubagentReceipt(content: string): TaskExecution {
  const match = /<todo-result>\s*([\s\S]*?)\s*<\/todo-result>/i.exec(content);
  if (!match?.[1]) {
    return { ok: false, error: "Subagent did not return a structured <todo-result> receipt." };
  }
  try {
    const value = JSON.parse(match[1]) as Record<string, unknown>;
    const status = value.status;
    if (status !== "completed" && status !== "failed" && status !== "blocked") {
      return { ok: false, error: "Subagent receipt has an invalid status." };
    }
    const summary = typeof value.summary === "string" ? value.summary : undefined;
    const error = typeof value.error === "string" ? value.error : undefined;
    const changedFiles = Array.isArray(value.changedFiles)
      ? value.changedFiles.filter((entry): entry is string => typeof entry === "string")
      : [];
    const checks: NonNullable<TaskExecution["checks"]> = Array.isArray(value.checks) ? value.checks.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const check = entry as Record<string, unknown>;
      if (typeof check.command !== "string") return [];
      if (check.status !== "passed" && check.status !== "failed" && check.status !== "not_run") return [];
      const status = check.status as "passed" | "failed" | "not_run";
      return [{
        command: check.command,
        status,
        ...(typeof check.output === "string" ? { output: check.output } : {}),
      }];
    }) : [];
    const failedCheck = checks.find((check) => check.status === "failed");
    if (status === "completed" && failedCheck) {
      return { ok: false, summary, changedFiles, checks, error: `Required check failed: ${failedCheck.command}` };
    }
    if (status === "completed" && checks.length > 0 && checks.every((check) => check.status === "not_run")) {
      return { ok: false, summary, changedFiles, checks, error: "Subagent reported completion without running any verification checks." };
    }
    return {
      ok: status === "completed",
      ...(summary ? { summary } : {}),
      ...(error ? { error } : {}),
      changedFiles,
      checks,
    };
  } catch {
    return { ok: false, error: "Subagent returned malformed JSON in its completion receipt." };
  }
}

/**
 * Runs one subagent-plan task and reports the outcome. The TUI wires this to
 * the `subagent` tool; tests inject a mock.
 */
export type SubagentExecutor = (plan: SubagentTaskCommand, signal?: AbortSignal) => Promise<TaskExecution>;

/** Launches a background task for bg-plan tasks; resolves to the task id. */
export type BgExecutor = (plan: BgTaskCommand) => Promise<string>;

/** Polls a background task until it reaches a terminal state. */
export type BgPoller = (taskId: string, signal?: AbortSignal) => Promise<TaskExecution & { done: boolean }>;

const SAFE_COMMAND_PREFIXES = [
  "npm install", "npm ci", "npm test", "npm run ",
  "pnpm install", "pnpm i", "pnpm test", "pnpm run ",
  "yarn install", "yarn test", "yarn run ",
  "bun install", "bun test", "bun run ",
  "tsc", "vitest", "jest",
] as const;

/**
 * Permit one package-manager/test/build command only. Shell composition,
 * redirection, substitutions and arbitrary executables are rejected.
 */
export function parseBgCommand(task: import("./types.ts").RunnerTask, raw: string): string {
  const command = raw.trim();
  if (!command || /[;&|<>`$\\\n\r]/.test(command) || /\$\(|\$\{|\\\\/.test(command)) {
    throw new Error(`Unsafe task command for ${task.label}`);
  }
  const executable = command.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (!SAFE_COMMAND_PREFIXES.some((prefix) => command.toLowerCase().startsWith(prefix)) &&
      !["tsc", "vitest", "jest"].includes(executable)) {
    throw new Error(`Unsupported task command for ${task.label}: ${command}`);
  }
  if (/\b(?:migrate|migration|db:|schema:)/i.test(command) && !/^(npm|pnpm|yarn|bun) run [a-z0-9:_-]+$/i.test(command)) {
    throw new Error(`Migration commands must use an explicit package script: ${command}`);
  }
  return command;
}
