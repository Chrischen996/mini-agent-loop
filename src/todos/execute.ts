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
};

export type RunnerTaskPlan = SubagentTaskCommand | BgTaskCommand;

/**
 * Map a runner task to its concrete execution plan. The mapping is derived
 * from the resource classification so test/CI todos run the repo's test
 * command, install todos run the package-manager install, and everything
 * else becomes a focused subagent prompt.
 */
export function planRunnerTask(
  task: import("./types.ts").RunnerTask,
  detectCommands?: BgCommandDetector,
): RunnerTaskPlan {
  if (task.runner === "bg") {
    const command = detectCommands?.(task) ?? defaultBgCommand(task);
    return {
      kind: "bg",
      command,
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
  };
}

export function defaultBgCommand(task: import("./types.ts").RunnerTask): string {
  switch (task.resourceClass) {
    case "test":
      return "npm test";
    case "build":
      return "npm run build";
    case "migration":
      return "npm run migrate";
    case "install":
    case "dependency":
    case "lockfile":
    default:
      return "npm install";
  }
}

export function subagentPromptFor(task: import("./types.ts").RunnerTask): string {
  const lines = [`Complete this task: ${task.content}`];
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

export type TaskExecution = { ok: boolean; summary?: string; error?: string };

/**
 * Runs one subagent-plan task and reports the outcome. The TUI wires this to
 * the `subagent` tool; tests inject a mock.
 */
export type SubagentExecutor = (plan: SubagentTaskCommand, signal?: AbortSignal) => Promise<TaskExecution>;

/** Launches a background task for bg-plan tasks; resolves to the task id. */
export type BgExecutor = (plan: BgTaskCommand) => Promise<string>;

/** Polls a background task until it reaches a terminal state. */
export type BgPoller = (taskId: string, signal?: AbortSignal) => Promise<TaskExecution & { done: boolean }>;

/** Default package manager detection: tries common command presence. */
const PACKAGE_MANAGERS = ["pnpm", "npm", "yarn", "bun"] as const;
function detectPackageManager(): string {
  for (const pm of PACKAGE_MANAGERS) {
    // Best-effort heuristic. In CI we cannot spawn processes here; fall back.
    try { require("child_process").spawnSync(pm, ["--version"], { stdio: "ignore" }); return pm; } catch {}
  }
  return "npm";
}

const SAFE_BG_COMMANDS = new Set([
  "npm install", "pnpm install", "yarn install", "bun install",
  "npm ci", "pnpm ci",
  "npm test", "pnpm test", "yarn test", "bun test",
  "npm run test", "pnpm run test", "yarn run test", "bun run test",
  "npm run build", "pnpm run build", "yarn run build", "bun run build",
  "npm run lint", "pnpm run lint", "yarn run lint",
  "tsc", "vitest", "jest",
]);

/**
 * Safe parser for bg commands: reject anything that looks destructive or
 * that matches a non-whitelisted prefix unless the user supplied it explicitly.
 */
export function parseBgCommand(task: import("./types.ts").RunnerTask, raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Task command must be non-empty");
  // allow explicit override only through planRunnerTask detectCommands; default
  // commands here stay within SAFE_BG_COMMANDS
  if (!SAFE_BG_COMMANDS.has(trimmed) && !trimmed.startsWith("npm ") && !trimmed.startsWith("pnpm ") &&
      !trimmed.startsWith("yarn ") && !trimmed.startsWith("bun ") &&
      !trimmed.startsWith("tsc") && !trimmed.startsWith("vitest") && !trimmed.startsWith("jest") &&
      !trimmed.startsWith("node ")) {
    throw new Error(`Unsafe task command for ${task.label}: ${trimmed}`);
  }
  return trimmed;
}
