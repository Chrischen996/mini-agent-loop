import { spawn } from "node:child_process";
import { platform } from "node:os";
import { isPathInsideCwd } from "../workspace.ts";
import { resolve } from "node:path";
import type { SandboxRunner, SandboxExecOptions, SandboxResult } from "./types.ts";

const INHERITED_ENVIRONMENT = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TERM",
  "CI",
]);

export class NodeSandboxRunner implements SandboxRunner {
  readonly type = "node" as const;
  readonly isolation = "process-isolation" as const;

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
      let timeoutHandle: NodeJS.Timeout | undefined;
      let forceKillHandle: NodeJS.Timeout | undefined;

      const clearTimeoutHandle = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
        if (forceKillHandle) {
          clearTimeout(forceKillHandle);
          forceKillHandle = undefined;
        }
      };

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
        clearTimeoutHandle();
        reject(new Error(`Failed to spawn process: ${err.message}`));
      });

      proc.on("close", (exitCode, signal) => {
        clearTimeoutHandle();
        resolve({
          stdout,
          stderr,
          exitCode: exitCode ?? -1,
          timedOut,
          signal: signal ?? undefined,
        });
      });

      if (timeout) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
          forceKillHandle = setTimeout(() => {
            forceKillHandle = undefined;
            proc.kill("SIGKILL");
          }, 1000);
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
    
    // Process isolation is not a secure sandbox. Keep credentials out of the
    // child by default while preserving enough environment for common tools.
    for (const [key, value] of Object.entries(process.env)) {
      if (!INHERITED_ENVIRONMENT.has(key) && !key.startsWith("LC_")) continue;
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
