import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { BackendStartResult, BgTaskBackend } from "./backend.js";
import { shellQuote } from "./utils.js";

const execFileAsync = promisify(execFile);

export class BgTmuxBackend implements BgTaskBackend {
  readonly kind = "tmux" as const;
  constructor(readonly socketName: string, private readonly runnerPath: string) {}

  async assertAvailable(): Promise<void> {
    if (process.platform === "win32") {
      throw new Error("bg-tasks requires tmux on macOS/Linux (or inside WSL)");
    }
    try {
      await execFileAsync("tmux", ["-V"], { timeout: 3000 });
    } catch {
      throw new Error("tmux is required but not found in PATH");
    }
  }

  async start(sessionName: string, cwd: string, taskDir: string, _logPath: string): Promise<BackendStartResult> {
    // Source checkouts run through tsx, while packaged builds contain a plain
    // JavaScript runner. Keep both entry points usable without changing the
    // persisted task format.
    const tsxLoader = join(dirname(this.runnerPath), "../../node_modules/tsx/dist/loader.mjs");
    const runnerLoader = this.runnerPath.endsWith(".ts")
      ? ` --import ${shellQuote(existsSync(tsxLoader) ? tsxLoader : "tsx")}`
      : "";
    const runnerCommand = `${shellQuote(process.execPath)}${runnerLoader} ${shellQuote(this.runnerPath)} ${shellQuote(taskDir)}`;
    await this.run([
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-c",
      cwd,
      runnerCommand,
    ]);
    return {};
  }

  async pipePane(sessionName: string, logPath: string): Promise<void> {
    const pipeCommand = `cat >> ${shellQuote(logPath)}`;
    await this.run(["pipe-pane", "-t", sessionName, "-o", pipeCommand]);
  }

  async hasSession(sessionName: string, _pid?: number, _taskDir?: string): Promise<boolean> {
    try {
      await this.run(["has-session", "-t", sessionName]);
      return true;
    } catch {
      return false;
    }
  }

  async sendLiteral(sessionName: string, text: string): Promise<void> {
    await this.run(["send-keys", "-t", sessionName, "-l", "--", text]);
  }

  async sendKey(sessionName: string, key: string): Promise<void> {
    await this.run(["send-keys", "-t", sessionName, key]);
  }

  async capturePane(sessionName: string, lines = 200, _logPath?: string): Promise<string> {
    const safeLines = Math.max(1, Math.min(500, Math.floor(lines)));
    const { stdout } = await this.run(["capture-pane", "-p", "-t", sessionName, "-S", `-${safeLines}`]);
    return stdout;
  }

  async kill(sessionName: string, _pid?: number, _force?: boolean, _taskDir?: string): Promise<void> {
    if (await this.hasSession(sessionName)) {
      await this.run(["kill-session", "-t", sessionName]).catch(() => undefined);
    }
  }

  dispose(): void {
    // Tasks intentionally outlive the manager and server process. The tmux
    // socket is isolated per manager instance, so no server-wide cleanup is
    // needed here.
  }

  attachCommand(sessionName: string): string {
    return `tmux -L ${shellQuote(this.socketName)} attach-session -t ${shellQuote(sessionName)}`;
  }

  async run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync("tmux", ["-L", this.socketName, ...args], {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 2 * 1024 * 1024,
      });
    } catch (error) {
      const execError = error as Error & { stderr?: string };
      throw new Error(`tmux ${args[0] ?? "command"} failed: ${execError.stderr?.trim() || execError.message}`);
    }
  }
}
