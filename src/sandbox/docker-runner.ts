import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { SandboxRunner, SandboxExecOptions, SandboxResult } from "./types.ts";
import { terminateProcessTree } from "../process-tree.ts";

export class DockerSandboxRunner implements SandboxRunner {
  readonly type = "docker" as const;
  readonly isolation = "secure-sandbox" as const;
  private containerIds = new Set<string>();

  constructor(private readonly image = "mini-agent-sandbox:latest") {}

  async execute(options: SandboxExecOptions): Promise<SandboxResult> {
    const {
      command,
      args = [],
      cwd,
      env = {},
      timeout = 30000,
      allowNetwork = false,
      allowWrite = false,
      cpuLimit = 1.0,
      memoryLimit = "512m",
      stdin,
      signal,
    } = options;

    if (signal?.aborted) {
      return Promise.reject(Object.assign(new Error("Operation aborted"), { name: "AbortError" }));
    }

    const containerId = this.generateContainerId();
    this.containerIds.add(containerId);

    try {
      const dockerArgs = this.buildDockerArgs({
        containerId,
        cwd,
        env,
        allowNetwork,
        allowWrite,
        cpuLimit,
        memoryLimit,
        command,
        args,
      });

      return await this.runContainer(dockerArgs, timeout, stdin, signal);
    } finally {
      await this.removeContainer(containerId);
      this.containerIds.delete(containerId);
    }
  }

  async cleanup(): Promise<void> {
    const promises = Array.from(this.containerIds).map((id) =>
      this.removeContainer(id),
    );
    await Promise.allSettled(promises);
    this.containerIds.clear();
  }

  private generateContainerId(): string {
    return `mini-agent-${randomBytes(8).toString("hex")}`;
  }

  private buildDockerArgs(params: {
    containerId: string;
    cwd: string;
    env: Record<string, string>;
    allowNetwork: boolean;
    allowWrite: boolean;
    cpuLimit: number;
    memoryLimit: string;
    command: string;
    args: string[];
  }): string[] {
    const {
      containerId,
      cwd,
      env,
      allowNetwork,
      allowWrite,
      cpuLimit,
      memoryLimit,
      command,
      args,
    } = params;

    const dockerArgs = [
      "run",
      "--rm",
      "--name",
      containerId,
      `--cpus=${cpuLimit}`,
      `--memory=${memoryLimit}`,
      "--pids-limit=50",
    ];

    if (!allowNetwork) {
      dockerArgs.push("--network=none");
    }

    const mountMode = allowWrite ? "rw" : "ro";
    dockerArgs.push("-v", `${cwd}:/workspace:${mountMode}`);
    dockerArgs.push("-w", "/workspace");

    for (const [key, value] of Object.entries(env)) {
      dockerArgs.push("-e", `${key}=${value}`);
    }

    dockerArgs.push(this.image, command, ...args);

    return dockerArgs;
  }

  private runContainer(
    dockerArgs: string[],
    timeout: number,
    stdin?: string,
    signal?: AbortSignal,
  ): Promise<SandboxResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn("docker", dockerArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let forceKillHandle: NodeJS.Timeout | undefined;
      let aborted = false;
      let settled = false;

      const scheduleForceKill = () => {
        if (forceKillHandle) return;
        forceKillHandle = setTimeout(() => {
          forceKillHandle = undefined;
          terminateProcessTree(proc, "SIGKILL");
        }, 1_000);
      };
      const abort = () => {
        aborted = true;
        terminateProcessTree(proc);
        scheduleForceKill();
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (forceKillHandle) clearTimeout(forceKillHandle);
        signal?.removeEventListener("abort", abort);
        fn();
      };

      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      if (stdin) {
        proc.stdin.write(stdin);
        proc.stdin.end();
      }

      proc.on("error", (err) => {
        settle(() => reject(new Error(`Docker spawn failed: ${err.message}`)));
      });

      proc.on("close", (exitCode, signalName) => {
        settle(() => {
          if (aborted) {
            reject(Object.assign(new Error("Operation aborted"), { name: "AbortError" }));
            return;
          }
          resolve({
            stdout,
            stderr,
            exitCode: exitCode ?? -1,
            timedOut,
            signal: signalName ?? undefined,
          });
        });
      });

      timeoutHandle = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(proc);
        scheduleForceKill();
      }, timeout);

      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private async removeContainer(containerId: string): Promise<void> {
    return new Promise((resolve) => {
      const proc = spawn("docker", ["rm", "-f", containerId], {
        stdio: "ignore",
      });
      proc.on("close", () => resolve());
      proc.on("error", () => resolve());
    });
  }
}
