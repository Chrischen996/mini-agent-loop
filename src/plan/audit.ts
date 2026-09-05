/**
 * Plan execution audit — compare planned files vs workspace changes,
 * and infer per-step status after a run.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlanDocumentStep, PlanStepStatus } from "./document.ts";

const execFileAsync = promisify(execFile);

async function workspaceFileHash(workspaceRoot: string, relativePath: string): Promise<string | null> {
  try {
    const bytes = await readFile(path.join(workspaceRoot, relativePath));
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return null;
  }
}

export type FileAuditResult = {
  changedFiles: string[];
  missingPlannedFiles: string[];
  unplannedFiles: string[];
  report: string;
  stepUpdates: Array<{ index: number; status: PlanStepStatus; reason?: string }>;
};

export function normalizePath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
}

/** Exact match after normalize, or basename / suffix fallback. */
export function pathsMatch(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`)) return true;
  const ba = na.split("/").pop() ?? na;
  const bb = nb.split("/").pop() ?? nb;
  return ba === bb && ba.length > 0;
}

function pathInList(path: string, list: string[]): boolean {
  return list.some((item) => pathsMatch(path, item));
}

export function auditPlanFiles(
  plannedFiles: string[],
  changedFiles: string[],
): Omit<FileAuditResult, "stepUpdates"> {
  const planned = Array.from(new Set(plannedFiles.map(normalizePath).filter(Boolean)));
  const changed = Array.from(new Set(changedFiles.map(normalizePath).filter(Boolean)));

  const missingPlannedFiles = planned.filter((p) => !pathInList(p, changed));
  const unplannedFiles = changed.filter((c) => !pathInList(c, planned));

  const lines: string[] = ["── Plan File Audit ──"];
  lines.push(
    `Changed (${changed.length}): ${changed.length ? changed.join(", ") : "(none)"}`,
  );
  lines.push(
    `Missing planned (${missingPlannedFiles.length}): ${
      missingPlannedFiles.length ? missingPlannedFiles.join(", ") : "(none)"
    }`,
  );
  lines.push(
    `Unplanned (${unplannedFiles.length}): ${
      unplannedFiles.length ? unplannedFiles.join(", ") : "(none)"
    }`,
  );

  return {
    changedFiles: changed,
    missingPlannedFiles,
    unplannedFiles,
    report: lines.join("\n"),
  };
}

/**
 * Heuristic step status inference after execution.
 */
export function inferStepStatuses(
  steps: PlanDocumentStep[] | undefined,
  changedFiles: string[],
  executionOk: boolean,
): Array<{ index: number; status: PlanStepStatus; reason?: string }> {
  if (!steps || steps.length === 0) return [];

  const updates: Array<{ index: number; status: PlanStepStatus; reason?: string }> = [];

  for (const step of steps) {
    const files = step.files ?? [];
    if (files.length > 0) {
      const hit = files.filter((f) => pathInList(f, changedFiles));
      if (hit.length > 0) {
        updates.push({
          index: step.index,
          status: "done",
          reason: `touched ${hit.join(", ")}`,
        });
      } else {
        updates.push({
          index: step.index,
          status: "todo",
          reason: `planned ${files.join(", ")} not changed`,
        });
      }
      continue;
    }

    if (executionOk) {
      updates.push({
        index: step.index,
        status: "done",
        reason: "no file targets; run succeeded",
      });
    } else {
      updates.push({
        index: step.index,
        status: "todo",
        reason: "no file targets",
      });
    }
  }

  if (!executionOk && updates.length > 0) {
    const anyDone = updates.some((u) => u.status === "done");
    if (!anyDone) {
      const last = updates[updates.length - 1]!;
      last.status = "failed";
      last.reason = last.reason
        ? `${last.reason}; execution failed`
        : "execution failed";
    } else {
      const firstTodo = updates.find((u) => u.status === "todo");
      if (firstTodo) {
        firstTodo.status = "failed";
        firstTodo.reason = firstTodo.reason
          ? `${firstTodo.reason}; execution failed`
          : "execution failed";
      }
    }
  }

  return updates;
}

export function formatAuditReport(input: {
  changedFiles: string[];
  missingPlannedFiles: string[];
  unplannedFiles: string[];
  plannedFiles: string[];
  stepUpdates?: Array<{ index: number; status: PlanStepStatus; reason?: string }>;
}): string {
  const base = auditPlanFiles(input.plannedFiles, input.changedFiles);
  const lines = [base.report];
  if (input.stepUpdates && input.stepUpdates.length > 0) {
    lines.push("Steps:");
    for (const u of input.stepUpdates) {
      lines.push(`  ${u.index}. ${u.status}${u.reason ? ` — ${u.reason}` : ""}`);
    }
  }
  return lines.join("\n");
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
    });
    return { ok: true, stdout: String(stdout ?? "") };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function parsePorcelainPaths(porcelain: string): string[] {
  const files: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    const rest = line.slice(3);
    if (!rest) continue;
    if (rest.includes(" -> ")) {
      const dest = rest.split(" -> ").pop();
      if (dest) files.push(normalizePath(dest.replace(/^"|"$/g, "")));
    } else {
      files.push(normalizePath(rest.replace(/^"|"$/g, "")));
    }
  }
  return files;
}

export async function captureBaseline(
  workspaceRoot: string,
): Promise<{ gitHead: string | null; dirtyFiles: string[]; dirtyFileHashes: Record<string, string | null> }> {
  const inside = await runGit(workspaceRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || !inside.stdout.trim().includes("true")) {
    return { gitHead: null, dirtyFiles: [], dirtyFileHashes: {} };
  }
  const head = await runGit(workspaceRoot, ["rev-parse", "HEAD"]);
  const status = await runGit(workspaceRoot, ["status", "--porcelain"]);
  const dirtyFiles = parsePorcelainPaths(status.stdout);
  const dirtyFileHashes = Object.fromEntries(await Promise.all(
    dirtyFiles.map(async (file) => [file, await workspaceFileHash(workspaceRoot, file)] as const),
  ));
  return {
    gitHead: head.ok ? head.stdout.trim() || null : null,
    dirtyFiles,
    dirtyFileHashes,
  };
}

export async function collectChangedFiles(
  workspaceRoot: string,
  baseline?: { dirtyFiles?: string[]; dirtyFileHashes?: Record<string, string | null> },
): Promise<string[]> {
  const inside = await runGit(workspaceRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || !inside.stdout.trim().includes("true")) {
    return [];
  }

  const status = await runGit(workspaceRoot, ["status", "--porcelain"]);
  const diff = await runGit(workspaceRoot, ["diff", "--name-only", "HEAD"]);
  const fromStatus = parsePorcelainPaths(status.stdout);
  const fromDiff = diff.ok
    ? diff.stdout
        .split("\n")
        .map((l) => normalizePath(l))
        .filter(Boolean)
    : [];

  const baselineFiles = new Set((baseline?.dirtyFiles ?? []).map(normalizePath));
  const baselineHashes = baseline?.dirtyFileHashes ?? {};
  const candidates = Array.from(new Set([...fromStatus, ...fromDiff]));
  const changed: string[] = [];
  for (const file of candidates) {
    if (!baselineFiles.has(file)) {
      changed.push(file);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(baselineHashes, file)) continue;
    const currentHash = await workspaceFileHash(workspaceRoot, file);
    if (currentHash !== baselineHashes[file]) changed.push(file);
  }
  return changed;
}

export async function runExecutionAudit(input: {
  plannedFiles: string[];
  steps?: PlanDocumentStep[];
  workspaceRoot: string;
  executionOk: boolean;
  baseline?: { gitHead?: string | null; dirtyFiles?: string[] };
}): Promise<FileAuditResult> {
  const changedFiles = await collectChangedFiles(input.workspaceRoot, input.baseline);
  const fileAudit = auditPlanFiles(input.plannedFiles, changedFiles);
  const stepUpdates = inferStepStatuses(input.steps, changedFiles, input.executionOk);
  const report = formatAuditReport({
    ...fileAudit,
    plannedFiles: input.plannedFiles,
    stepUpdates,
  });
  return {
    ...fileAudit,
    report,
    stepUpdates,
  };
}
