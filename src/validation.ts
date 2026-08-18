import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

export type ValidationStepName = "test" | "typecheck" | "build";
export type ValidationStep = {
  name: ValidationStepName;
  command: string;
  args: string[];
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  exitCode?: number;
  output: string;
};
export type ValidationReport = {
  workspace: string;
  ok: boolean;
  steps: ValidationStep[];
  startedAt: number;
  finishedAt: number;
};

export type ValidationOptions = {
  workspace: string;
  steps?: ValidationStepName[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
};

function packageManager(workspace: string): string {
  // npm is available with Node installations and can run the package scripts
  // regardless of whether the repository also keeps a pnpm/yarn lockfile.
  return "npm";
}

async function scripts(workspace: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(path.join(workspace, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch { return {}; }
}

export async function runValidation(options: ValidationOptions): Promise<ValidationReport> {
  const startedAt = Date.now();
  const available = await scripts(options.workspace);
  const requested = options.steps ?? ["test", "typecheck", "build"];
  const manager = packageManager(options.workspace);
  const steps: ValidationStep[] = [];
  for (const name of requested) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Validation aborted");
    if (!available[name]) continue;
    const command = manager;
    const args = ["run", name, "--if-present"];
    const stepStarted = Date.now();
    let output = "";
    let ok = false;
    let exitCode: number | undefined;
    try {
      const result = await execFileAsync(command, args, {
        cwd: options.workspace,
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: options.maxOutputBytes ?? 256 * 1024,
        signal: options.signal,
        env: { ...process.env, CI: process.env.CI ?? "1" },
      });
      output = `${result.stdout}${result.stderr}`.slice(-(options.maxOutputBytes ?? 256 * 1024));
      ok = true;
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; status?: number; code?: number | string; message?: string };
      output = `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`.slice(-(options.maxOutputBytes ?? 256 * 1024));
      exitCode = typeof err.status === "number" ? err.status : typeof err.code === "number" ? err.code : undefined;
    }
    steps.push({ name, command, args, startedAt: stepStarted, finishedAt: Date.now(), ok, exitCode, output });
    if (!ok) break;
  }
  return { workspace: options.workspace, ok: steps.every((step) => step.ok), steps, startedAt, finishedAt: Date.now() };
}

export function formatValidationReport(report: ValidationReport): string {
  if (report.steps.length === 0) return "No validation scripts configured (test/typecheck/build).";
  return report.steps.map((step) => `# ${step.name}: ${step.ok ? "PASS" : "FAIL"}\n${step.output.slice(-1_000)}`).join("\n\n");
}
