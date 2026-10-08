import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { shellQuote } from "./utils.js";

const execFileAsync = promisify(execFile);

export class BgTmuxBackend {
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

  async start(sessionName: string, cwd: string, taskDir: string): Promise<void> {
    const runnerCommand = `${shellQuote(process.execPath)} ${shellQuote(this.runnerPath)} ${shellQuote(taskDir)}`;
    await this.run([
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-c",
      cwd,
      runnerCommand,
    ]);
  }

  async pipePane(sessionName: string, logPath: string): Promise<void> {
    const pipeCommand = `cat >> ${shellQuote(logPath)}`;
    await this.run(["pipe-pane", "-t", sessionName, "-o", pipeCommand]);
  }

  async hasSession(sessionName: string): Promise<boolean> {
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

  async capturePane(sessionName: string, lines = 200): Promise<string> {
    const safeLines = Math.max(1, Math.min(500, Math.floor(lines)));
    const { stdout } = await this.run(["capture-pane", "-p", "-t", sessionName, "-S", `-${safeLines}`]);
    return stdout;
  }

  async kill(sessionName: string): Promise<void> {
    if (await this.hasSession(sessionName)) {
      await this.run(["kill-session", "-t", sessionName]).catch(() => undefined);
    }
  }

  async killServer(): Promise<void> {
    try {
      await this.run(["kill-server"]).catch(() => undefined);
    } catch {
      // ignore
    }
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
