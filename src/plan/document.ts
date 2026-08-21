/**
 * Plan document model (v2) — structured plan with lifecycle status.
 */

import { randomUUID } from "node:crypto";
import { parsePlan, type PlanSummary, type PlanStep } from "../plan-formatter.ts";

export type PlanStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executing"
  | "completed"
  | "failed";

export type PlanStepStatus = "todo" | "doing" | "done" | "skipped" | "failed";

export type PlanDocumentStep = {
  index: number;
  text: string;
  files?: string[];
  tool?: string;
  status?: PlanStepStatus;
};

export type PlanExecutionBaseline = {
  gitHead?: string | null;
  dirtyFiles?: string[];
  dirtyFileHashes?: Record<string, string | null>;
};

export type PlanExecutionState = {
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  lastResultSummary?: string;
  /** Workspace-relative paths changed during/around execution. */
  changedFiles?: string[];
  /** Files listed in the plan but not observed as changed. */
  missingPlannedFiles?: string[];
  /** Files changed but not listed in the plan. */
  unplannedFiles?: string[];
  /** Human-readable audit report. */
  auditReport?: string;
  /** Snapshot captured before execution. */
  baseline?: PlanExecutionBaseline;
};

export type PlanDocument = {
  version: 2;
  id: string;
  prompt: string;
  rawMarkdown: string;
  steps?: PlanDocumentStep[];
  files: string[];
  status: PlanStatus;
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  execution?: PlanExecutionState;
};

/** Legacy v1 plan file shape (still written for compatibility). */
export type PlanFile = {
  version: 1;
  prompt: string;
  plan: string;
  /** Approval status: "pending" | "approved" | "rejected" */
  approval: "pending" | "approved" | "rejected";
  /** Approved-by: "user" | "auto--yes" */
  approvedBy?: string;
  /** Timestamp of last modification */
  updatedAt: string;
  mode: "plan";
  cwd: string;
  timestamp: string;
};

function stepsFromSummary(summary: PlanSummary): PlanDocumentStep[] {
  return summary.steps.map((s: PlanStep) => ({
    index: s.index,
    text: s.text,
    files: s.files,
    tool: s.tool,
    status: "todo" as const,
  }));
}

export function createPlanDocument(input: {
  prompt: string;
  rawMarkdown: string;
  cwd: string;
  status?: PlanStatus;
  approvedBy?: string;
  id?: string;
}): PlanDocument {
  const now = new Date().toISOString();
  const summary = parsePlan(input.prompt, input.rawMarkdown);
  return {
    version: 2,
    id: input.id ?? randomUUID(),
    prompt: input.prompt,
    rawMarkdown: input.rawMarkdown,
    steps: stepsFromSummary(summary),
    files: summary.files,
    status: input.status ?? "pending",
    approvedBy: input.approvedBy,
    createdAt: now,
    updatedAt: now,
    cwd: input.cwd,
  };
}

export function planDocumentToSummary(doc: PlanDocument): PlanSummary {
  return parsePlan(doc.prompt, doc.rawMarkdown);
}

/** Map full v2 status onto legacy approval field. */
export function statusToLegacyApproval(
  status: PlanStatus,
): PlanFile["approval"] {
  if (status === "pending") return "pending";
  if (status === "rejected") return "rejected";
  // approved / executing / completed / failed → approved for legacy consumers
  return "approved";
}

export function legacyPlanFileToDocument(v1: PlanFile): PlanDocument {
  const summary = parsePlan(v1.prompt, v1.plan);
  const status: PlanStatus =
    v1.approval === "approved"
      ? "approved"
      : v1.approval === "rejected"
        ? "rejected"
        : "pending";
  const createdAt = v1.timestamp || v1.updatedAt;
  return {
    version: 2,
    id: randomUUID(),
    prompt: v1.prompt,
    rawMarkdown: v1.plan,
    steps: stepsFromSummary(summary),
    files: summary.files,
    status,
    approvedBy: v1.approvedBy,
    createdAt,
    updatedAt: v1.updatedAt || createdAt,
    cwd: v1.cwd,
  };
}

export function documentToLegacyPlanFile(doc: PlanDocument): PlanFile {
  return {
    version: 1,
    prompt: doc.prompt,
    plan: doc.rawMarkdown,
    approval: statusToLegacyApproval(doc.status),
    approvedBy: doc.approvedBy,
    updatedAt: doc.updatedAt,
    mode: "plan",
    cwd: doc.cwd,
    timestamp: doc.createdAt,
  };
}
