import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { BackendStartResult, BgTaskBackend } from "./backend.js";

const execFileAsync = promisify(execFile);

function runnerArgs(runnerPath: string, taskDir: string): string[] {
  if (!runnerPath.endsWith(".ts")) return [runnerPath, taskDir];
  const tsxLoader = join(dirname(runnerPath), "../../node_modules/tsx/dist/loader.mjs");
  return ["--import", existsSync(tsxLoader) ? tsxLoader : "tsx", runnerPath, taskDir];
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    throw new Error("process groups are not available through POSIX signals on Windows");
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    try {
      process.kill(pid, signal);
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException).code !== "ESRCH") throw fallbackError;
    }
  }
}

/** Detached runner backend used when tmux is unavailable or explicitly disabled. */
export class BgProcessBackend implements BgTaskBackend {
  readonly kind = "process" as const;
  readonly socketName = "process";

  constructor(private readonly runnerPath: string) {}

  async assertAvailable(): Promise<void> {
    // Node is already running this manager, so the process backend has no
    // external daemon prerequisite.
  }

  async start(_sessionName: string, cwd: string, taskDir: string, logPath: string): Promise<BackendStartResult> {
    const logFd = openSync(logPath, "a", 0o600);
    try {
      const child = spawn(process.execPath, runnerArgs(this.runnerPath, taskDir), {
        cwd,
        detached: true,
        env: { ...process.env, MINI_AGENT_BG_TASK_DIR: taskDir },
        stdio: ["ignore", logFd, logFd],
      });
      const pid = await new Promise<number>((resolve, reject) => {
        let spawned = false;
        const onError = (error: Error) => {
          if (!spawned) reject(error);
        };
        const onSpawn = () => {
          spawned = true;
          if (child.pid === undefined) {
            reject(new Error("Failed to start background runner"));
            return;
          }
          resolve(child.pid);
        };
        child.on("error", onError);
        child.once("spawn", onSpawn);
      });
      child.unref();
      return { pid };
    } finally {
      closeSync(logFd);
    }
  }

  async pipePane(_sessionName: string, _logPath: string): Promise<void> {
    // Runner stdout/stderr already points at output.log.
  }

  async hasSession(_sessionName: string, pid?: number, taskDir?: string): Promise<boolean> {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      if (process.platform === "win32") return true;
      if (!taskDir) return true;
      const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], { timeout: 2000 });
      return stdout.includes(taskDir);
    } catch {
      return false;
    }
  }

  async sendLiteral(_sessionName: string, _text: string): Promise<void> {
    throw new Error("bg_send is unavailable for process-backed tasks; use tmux backend for interactive input");
  }

  async sendKey(_sessionName: string, _key: string): Promise<void> {
    throw new Error("bg_send is unavailable for process-backed tasks; use tmux backend for interactive input");
  }

  async capturePane(_sessionName: string, lines = 200, logPath?: string): Promise<string> {
    if (!logPath) throw new Error("Live screen capture is unavailable without a task log");
    const safeLines = Math.max(1, Math.min(500, Math.floor(lines)));
    const text = readFileSync(logPath, "utf8").slice(-512 * 1024);
    return text.split("\n").slice(-safeLines).join("\n");
  }

  async kill(_sessionName: string, pid?: number, force = false, taskDir?: string): Promise<void> {
    if (!pid) return;
    if (taskDir && !(await this.hasSession(_sessionName, pid, taskDir))) return;
    if (process.platform === "win32") {
      await execFileAsync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true }).catch(() => undefined);
      return;
    }
    signalProcess(pid, force ? "SIGKILL" : "SIGTERM");
  }

  dispose(): void {
    // Detached tasks intentionally outlive the manager process.
  }
}
