import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolResult, ToolExecutionOptions } from "./types.ts";
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig, type SandboxResult, type SandboxRunner } from "../sandbox/types.ts";
import { terminateProcessTree } from "../process-tree.ts";
import { describeShell, resolveShell } from "./shell.ts";
import type { BgTaskManager } from "../bg-tasks/manager.js";

export type BashArgs = { command: string; timeout?: number; is_background?: boolean };

/** Maximum output size in bytes before truncation notice is appended. */
const MAX_OUTPUT_BYTES = 100 * 1024;
const DEFAULT_FOREGROUND_BLOCK_BUDGET_MS = 15_000;

function foregroundBlockBudgetMs(timeoutSeconds: number): number {
  const configured = process.env.MINI_AGENT_BG_FOREGROUND_MS;
  const parsed = configured === undefined ? DEFAULT_FOREGROUND_BLOCK_BUDGET_MS : Number(configured);
  const budget = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_FOREGROUND_BLOCK_BUDGET_MS;
  return budget === 0 ? timeoutSeconds * 1000 : Math.min(budget, timeoutSeconds * 1000);
}

async function readBackgroundOutput(manager: Pick<BgTaskManager, "logs">, taskId: string): Promise<{ text: string; truncated: boolean }> {
  const chunks: string[] = [];
  let offset = 0;
  let endOfLog = false;
  while (!endOfLog && offset < MAX_OUTPUT_BYTES) {
    const limitBytes = Math.min(65_536, MAX_OUTPUT_BYTES - offset);
    if (limitBytes < 4) break;
    const chunk = await manager.logs(taskId, offset, limitBytes);
    chunks.push(chunk.text);
    endOfLog = chunk.endOfLog;
    if (chunk.nextOffset === offset && !endOfLog) break;
    offset = chunk.nextOffset;
  }
  return { text: chunks.join(""), truncated: !endOfLog };
}

async function completedBackgroundResult(
  manager: Pick<BgTaskManager, "get" | "logs">,
  taskId: string,
): Promise<ToolResult> {
  const task = await manager.get(taskId);
  if (!task) return { content: `Background task disappeared: ${taskId}`, isError: true };
  const output = await readBackgroundOutput(manager, taskId);
  const truncation = output.truncated ? `\n\n[notice: output truncated to ${MAX_OUTPUT_BYTES} bytes]` : "";
  const suffix = task.status === "timed_out"
    ? "\n\n[command timed out]"
    : task.status === "completed" && task.exitCode === 0
      ? ""
      : `\n\n[exit code: ${task.exitCode ?? task.signal ?? task.status}]`;
  return { content: output.text + truncation + suffix, isError: task.status !== "completed" || task.exitCode !== 0 };
}

export function createBashTool(
  cwd: string,
  sandbox?: { runner: SandboxRunner; config?: Partial<SandboxConfig> },
  backgroundTaskManager?: Pick<
    BgTaskManager,
    | "projectCwd"
    | "start"
    | "wait"
    | "get"
    | "logs"
    | "terminate"
    | "registerForegroundWait"
    | "enableCompletionNotification"
  >,
): Tool<BashArgs> {
  const sandboxConfig = sandbox
    ? { ...DEFAULT_SANDBOX_CONFIG, ...sandbox.config }
    : undefined;
  // Resolve once so the advertised syntax matches the executor, including
  // Linux containers launched from a Windows host.
  const shell = sandbox?.runner.type === "docker"
    ? { command: "bash", args: ["-lc"], kind: "bash" as const }
    : resolveShell();
  const backgroundTasksAvailable = Boolean(backgroundTaskManager)
    && (!sandbox || sandbox.runner.type === "none");

  return {
    name: "bash",
    description: `${describeShell(shell)}${backgroundTasksAvailable ? " Long foreground commands automatically continue as persistent background tasks after the foreground wait budget (default 15 seconds). Set is_background=true to background immediately." : ""}`,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command in the shell syntax described by this tool" },
        timeout: { type: "number", minimum: 0.1, description: "Maximum foreground wait or background runtime, in seconds" },
        ...(backgroundTasksAvailable
          ? { is_background: { type: "boolean", description: "Start as a persistent background task and return immediately with its task ID" } }
          : {}),
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(args, signal, execution?: ToolExecutionOptions): Promise<ToolResult> {
      if (typeof args.command !== "string" || !args.command.trim()) {
        return { content: "command must be a non-empty string", isError: true };
      }
      if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });

      const configuredTimeoutSeconds = sandboxConfig?.timeout === undefined
        ? 30
        : sandboxConfig.timeout / 1000;
      const timeoutSeconds = args.timeout ?? configuredTimeoutSeconds;
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        return { content: "Invalid timeout: must be greater than 0 seconds", isError: true };
      }
      const effectiveTimeoutMs = Math.min(timeoutSeconds * 1000, Number.MAX_SAFE_INTEGER);

      const executionCwd = execution?.cwd ?? cwd;

      if (args.is_background === true) {
        if (!backgroundTaskManager || !backgroundTasksAvailable) {
          return { content: "Background execution is unavailable for this bash configuration", isError: true };
        }
        try {
          const [projectRoot, commandCwd] = await Promise.all([
            realpath(backgroundTaskManager.projectCwd),
            realpath(executionCwd),
          ]);
          const task = await backgroundTaskManager.start({
            command: args.command,
            cwd: path.relative(projectRoot, commandCwd) || undefined,
            timeoutSeconds: args.timeout,
          });
          return {
            content: `Started background task ${task.taskId} (${task.name}); status: ${task.status}. Use bg_status, bg_logs, bg_wait, or bg_kill to manage it.`,
          };
        } catch (err) {
          if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) throw err;
          return { content: `Background task failed to start: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      }

      if (backgroundTasksAvailable && backgroundTaskManager) {
        try {
          const [projectRoot, commandCwd] = await Promise.all([
            realpath(backgroundTaskManager.projectCwd),
            realpath(executionCwd),
          ]);
          const task = await backgroundTaskManager.start({
            command: args.command,
            cwd: path.relative(projectRoot, commandCwd) || undefined,
            notifyOnCompletion: false,
          });
          const budgetMs = foregroundBlockBudgetMs(timeoutSeconds);
          let resolvePromoted!: (value: "background") => void;
          const promoted = new Promise<"background">((resolve) => {
            resolvePromoted = resolve;
          });
          let promotedByShortcut = false;
          const unregisterForegroundWait = backgroundTaskManager.registerForegroundWait(task.taskId, async () => {
            const current = await backgroundTaskManager.get(task.taskId);
            if (!current || !["starting", "running", "unknown"].includes(current.status)) return false;
            await backgroundTaskManager.enableCompletionNotification(task.taskId);
            promotedByShortcut = true;
            resolvePromoted("background");
            return true;
          });
          try {
            const outcome = await Promise.race([
              backgroundTaskManager.wait([task.taskId], "all", budgetMs / 1000, signal)
                .then((result) => result.timedOut ? "background" as const : "completed" as const),
              promoted,
            ]);
            if (outcome === "completed") return await completedBackgroundResult(backgroundTaskManager, task.taskId);

            await backgroundTaskManager.enableCompletionNotification(task.taskId);
            const output = await readBackgroundOutput(backgroundTaskManager, task.taskId);
            const prefix = output.text ? `${output.text}\n\n` : "";
            const truncation = output.truncated ? `[notice: output truncated to ${MAX_OUTPUT_BYTES} bytes]\n\n` : "";
            return {
              content: `${prefix}${truncation}[command running in background: ${task.taskId}] Use bg_status, bg_logs, bg_wait, or bg_kill to manage it.`,
            };
          } catch (err) {
            if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
              if (!promotedByShortcut) await backgroundTaskManager.terminate(task.taskId, true).catch(() => undefined);
              throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
            }
            throw err;
          } finally {
            unregisterForegroundWait();
          }
        } catch (err) {
          if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) throw err;
          return { content: `Background command failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      }

      // Sandbox mode: use the runner directly (command-level exec only)
      if (sandbox && sandbox.runner.type !== "none") {
        try {
          // The Node runner executes on the host, so use the host shell. Docker
          // runners execute inside a Linux container where bash is available.
          const execShell = sandbox.runner.type === "docker"
            ? { command: "bash", args: ["-lc"] }
            : shell;
          const result: SandboxResult = await sandbox.runner.execute({
            command: execShell.command,
            args: [...execShell.args, args.command],
            cwd: executionCwd,
            timeout: effectiveTimeoutMs,
            allowNetwork: sandboxConfig?.allowNetwork ?? false,
            allowWrite: true,
            signal,
          });

          const content = result.stdout + (result.stderr ? `\n${result.stderr}` : "");
          const truncated = Buffer.byteLength(result.stdout, "utf8") > MAX_OUTPUT_BYTES
            ? `[notice: output truncated to ${MAX_OUTPUT_BYTES} bytes]`
            : "";
          const suffix = result.timedOut
            ? `\n\n[command timed out after ${effectiveTimeoutMs / 1000} seconds]`
            : result.exitCode === 0 ? ""
              : `\n\n[exit code: ${result.exitCode}${result.signal ? ` (signal ${result.signal})` : ""}]`;
          return { content: content + truncated + suffix, isError: result.timedOut || result.exitCode !== 0 };
        } catch (err) {
          if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) throw err;
          return { content: `Sandbox execution failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      }

      // Fallback: spawn directly (original behavior)
      return await new Promise((resolve, reject) => {
        const child = spawn(shell.command, [...shell.args, args.command], {
          cwd: executionCwd,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        let timer: NodeJS.Timeout | undefined;
        let forceKillTimer: NodeJS.Timeout | undefined;
        let settled = false;
        let aborted = false;
        let timedOut = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (forceKillTimer) clearTimeout(forceKillTimer);
          signal?.removeEventListener("abort", abort);
          fn();
        };
        const collect = (chunk: Buffer) => {
          if (size >= MAX_OUTPUT_BYTES) {
            truncated = true;
            return;
          }
          const remaining = MAX_OUTPUT_BYTES - size;
          chunks.push(chunk.subarray(0, remaining));
          size += Math.min(chunk.byteLength, remaining);
          if (chunk.byteLength > remaining) truncated = true;
        };
        const abort = () => {
          aborted = true;
          terminateProcessTree(child);
          if (!forceKillTimer) {
            forceKillTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), 1_000);
          }
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        child.once("error", (error) => finish(() => reject(error)));
        child.once("close", (code, signalName) => {
          finish(() => {
            if (aborted) {
              reject(Object.assign(new Error("Operation aborted"), { name: "AbortError" }));
              return;
            }
            const output = Buffer.concat(chunks).toString("utf8");
            const notice = truncated ? `\n\n[notice: output truncated to ${MAX_OUTPUT_BYTES} bytes]` : "";
            const suffix = timedOut
              ? `\n\n[command timed out after ${effectiveTimeoutMs / 1000} seconds]`
              : code === 0 ? "" : `\n\n[exit code: ${code ?? `signal ${signalName ?? "unknown"}`}]`;
            resolve({ content: output + notice + suffix, isError: timedOut || code !== 0 });
          });
        });
        timer = setTimeout(() => {
          timedOut = true;
          terminateProcessTree(child);
          if (!forceKillTimer) {
            forceKillTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), 1_000);
          }
        }, effectiveTimeoutMs);
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
      });
    },
  };
}
