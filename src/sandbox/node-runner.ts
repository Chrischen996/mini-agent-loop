import { spawn } from "node:child_process";
import { platform } from "node:os";
import { isPathInsideCwd } from "../workspace.ts";
import { resolve } from "node:path";
import type { SandboxRunner, SandboxExecOptions, SandboxResult } from "./types.ts";

export class NodeSandboxRunner implements SandboxRunner {
  readonly type = "node" as const;

  async execute(options: SandboxExecOptions): Promise<SandboxResult> {
    const {
      command,
      args = [],
      cwd,
      env = {},
      timeout = 30000,
      allowNetwork = false,
      stdin,
    } = options;

    return new Promise((resolve, reject) => {
      const finalEnv = this.prepareEnvironment(env, allowNetwork);
      const proc = spawn(command, args, {
        cwd,
        env: finalEnv,
        timeout,
        shell: false,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      proc.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      proc.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      if (stdin) {
        proc.stdin?.write(stdin);
        proc.stdin?.end();
      }

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn process: ${err.message}`));
      });

      proc.on("close", (exitCode, signal) => {
        resolve({
          stdout,
          stderr,
          exitCode: exitCode ?? -1,
          timedOut,
          signal: signal ?? undefined,
        });
      });

      if (timeout) {
        setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
          setTimeout(() => proc.kill("SIGKILL"), 1000);
        }, timeout);
      }
    });
  }

  async cleanup(): Promise<void> {
    // Node runner doesn't need cleanup
  }

  private prepareEnvironment(
    userEnv: Record<string, string>,
    allowNetwork: boolean,
  ): Record<string, string> {
    const env: Record<string, string> = {};
    
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    
    Object.assign(env, userEnv);

    if (!allowNetwork) {
      env.http_proxy = "http://127.0.0.1:0";
      env.https_proxy = "http://127.0.0.1:0";
      env.HTTP_PROXY = "http://127.0.0.1:0";
      env.HTTPS_PROXY = "http://127.0.0.1:0";
      env.no_proxy = "";
      env.NO_PROXY = "";
    }

    // Resource limits via environment (Node.js specific)
    if (!env.NODE_OPTIONS) {
      env.NODE_OPTIONS = "--max-old-space-size=512";
    }

    return env;
  }
}
