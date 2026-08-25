import { spawn } from "node:child_process";
import type { Tool, ToolResult } from "./types.ts";
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig, type SandboxResult, type SandboxRunner } from "../sandbox/types.ts";

export type BashArgs = { command: string; timeout?: number };

const MAX_OUTPUT_BYTES = 100 * 1024;

export function createBashTool(
  cwd: string,
  sandbox?: { runner: SandboxRunner; config?: Partial<SandboxConfig> },
): Tool<BashArgs> {
  const sandboxConfig = sandbox
    ? { ...DEFAULT_SANDBOX_CONFIG, ...sandbox.config }
    : undefined;

  return {
    name: "bash",
    description: "Execute a bash command. Returns stdout/stderr. Optional timeout.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        timeout: { type: "number", minimum: 0.1, description: "Timeout in seconds" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(args, signal): Promise<ToolResult> {
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

      // Sandbox mode: use the runner directly (command-level exec only)
      if (sandbox && sandbox.runner.type !== "none") {
        try {
          const result: SandboxResult = await sandbox.runner.execute({
            command: "bash",
            args: ["-lc", args.command],
            cwd,
            timeout: effectiveTimeoutMs,
            allowNetwork: sandboxConfig?.allowNetwork ?? false,
            allowWrite: true,
          });

          const content = result.stdout + (result.stderr ? `\n${result.stderr}` : "");
          const truncated = result.stdout.length > MAX_OUTPUT_BYTES
            ? `[notice: output truncated to ${MAX_OUTPUT_BYTES} bytes]`
            : "";
          const suffix = result.exitCode === 0 ? ""
            : result.timedOut
              ? `\n\n[command timed out after ${effectiveTimeoutMs / 1000} seconds]`
              : `\n\n[exit code: ${result.exitCode}${result.signal ? ` (signal ${result.signal})` : ""}]`;
          return { content: content + truncated + suffix, isError: result.exitCode !== 0 };
        } catch (err) {
          return { content: `Sandbox execution failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      }

      // Fallback: spawn directly (original behavior)
      return await new Promise((resolve, reject) => {
        const child = spawn("bash", ["-lc", args.command], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        let timer: NodeJS.Timeout | undefined;
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
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
          child.kill("SIGTERM");
          finish(() => reject(Object.assign(new Error("Operation aborted"), { name: "AbortError" })));
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        child.once("error", (error) => finish(() => reject(error)));
        child.once("close", (code, signalName) => {
          finish(() => {
            const output = Buffer.concat(chunks).toString("utf8");
            const notice = truncated ? `\n\n[notice: output truncated to ${MAX_OUTPUT_BYTES} bytes]` : "";
            const suffix = code === 0 ? "" : `\n\n[exit code: ${code ?? `signal ${signalName ?? "unknown"}`}]`;
            resolve({ content: output + notice + suffix, isError: code !== 0 });
          });
        });
        if (args.timeout !== undefined) {
          if (!Number.isFinite(args.timeout) || args.timeout <= 0) {
            child.kill("SIGTERM");
            finish(() => resolve({ content: "Invalid timeout: must be greater than 0 seconds", isError: true }));
            return;
          }
          timer = setTimeout(() => {
            child.kill("SIGTERM");
            finish(() => resolve({ content: `Command timed out after ${args.timeout} seconds`, isError: true }));
          }, args.timeout * 1000);
        }
        signal?.addEventListener("abort", abort, { once: true });
      });
    },
  };
}
