/**
 * Unified plan workflow API — create, approve, execute, mark results.
 */

import { runExecutionAudit, captureBaseline } from "./audit.ts";
import {
  createPlanDocument,
  planDocumentToSummary,
  type PlanDocument,
  type PlanStatus,
  type PlanStepStatus,
} from "./document.ts";
import {
  archivePlanDocument,
  clearPlanDocument,
  loadPlanDocument,
  savePlanDocument,
  updatePlanDocument,
} from "./store.ts";

export const PLAN_ONLY_SUFFIX =
  "\n\n⚠️ PLAN-ONLY MODE: produce a detailed execution plan only. Do NOT call write/edit/bash tools. Output your plan as markdown and stop.";

export function getExecutionPromptSuffix(doc: PlanDocument): string {
  const stepLines =
    doc.steps && doc.steps.length > 0
      ? doc.steps
          .map((s) => {
            const st = s.status ?? "todo";
            const files =
              s.files && s.files.length > 0 ? ` (${s.files.join(", ")})` : "";
            return `${s.index}. [${st}] ${s.text}${files}`;
          })
          .join("\n")
      : "(no structured steps)";

  const fileLines =
    doc.files.length > 0
      ? doc.files.map((f) => `- ${f}`).join("\n")
      : "(none detected)";

  return [
    "",
    "## Saved Plan (approved)",
    doc.rawMarkdown,
    "",
    "## Steps",
    stepLines,
    "",
    "## Planned files",
    fileLines,
    "",
    "Execute the above plan. Follow steps in order when possible.",
    "Prefer only planned files; do not expand scope without reason.",
    "Do not deviate from the plan.",
  ].join("\n");
}

export async function createAndSavePlan(
  cwd: string,
  prompt: string,
  rawMarkdown: string,
  opts: { autoApprove?: boolean; approvedBy?: string } = {},
): Promise<PlanDocument> {
  const status: PlanStatus = opts.autoApprove ? "approved" : "pending";
  const doc = createPlanDocument({
    prompt,
    rawMarkdown,
    cwd,
    status,
    approvedBy: opts.autoApprove
      ? (opts.approvedBy ?? "auto")
      : opts.approvedBy,
  });
  await savePlanDocument(cwd, doc);
  return doc;
}

export async function approveCurrentPlan(cwd: string, by: string): Promise<PlanDocument> {
  return updatePlanDocument(cwd, (doc) => {
    doc.status = "approved";
    doc.approvedBy = by;
    return doc;
  });
}

export async function rejectCurrentPlan(cwd: string): Promise<PlanDocument> {
  return updatePlanDocument(cwd, (doc) => {
    doc.status = "rejected";
    doc.approvedBy = undefined;
    return doc;
  });
}

export async function editCurrentPlan(
  cwd: string,
  nextMarkdown: string,
): Promise<PlanDocument> {
  return updatePlanDocument(cwd, (doc) => {
    doc.rawMarkdown = nextMarkdown;
    doc.status = "pending";
    doc.approvedBy = undefined;
    // refresh derived fields
    const summary = planDocumentToSummary({ ...doc, rawMarkdown: nextMarkdown });
    doc.steps = summary.steps.map((s) => ({
      index: s.index,
      text: s.text,
      files: s.files,
      tool: s.tool,
      status: "todo" as const,
    }));
    doc.files = summary.files;
    doc.execution = undefined;
    return doc;
  });
}

export async function updatePlanStepStatus(
  cwd: string,
  index: number,
  status: PlanStepStatus,
): Promise<PlanDocument> {
  return updatePlanDocument(cwd, (doc) => {
    if (!doc.steps) return doc;
    doc.steps = doc.steps.map((s) =>
      s.index === index ? { ...s, status } : s,
    );
    return doc;
  });
}

const READY_FOR_EXECUTION: PlanStatus[] = [
  "approved",
  "executing",
  "failed",
  "completed",
];

export async function preparePlanForExecution(
  cwd: string,
  opts: { yes?: boolean; force?: boolean; workspaceRoot?: string } = {},
): Promise<{ document: PlanDocument; executionPromptSuffix: string }> {
  let doc = await loadPlanDocument(cwd);
  if (!doc) {
    throw new Error("No saved plan found. Run with --plan first.");
  }

  if (doc.status === "rejected" && !opts.force) {
    throw new Error("Plan is rejected — cannot execute without --plan-force.");
  }

  if (!READY_FOR_EXECUTION.includes(doc.status) && doc.status !== "rejected") {
    // pending (or unknown)
    if (opts.yes) {
      doc = await approveCurrentPlan(cwd, "auto");
    } else if (!opts.force) {
      throw new Error(
        "Plan exists but is not approved. Approve it first, or pass --yes to auto-approve.",
      );
    }
  }

  // force can override rejected/pending into execution
  if (doc.status === "rejected" && opts.force) {
    doc = await updatePlanDocument(cwd, (d) => {
      d.status = "approved";
      d.approvedBy = d.approvedBy ?? "force";
      return d;
    });
  } else if (doc.status === "pending" && opts.force) {
    doc = await updatePlanDocument(cwd, (d) => {
      d.status = "approved";
      d.approvedBy = d.approvedBy ?? "force";
      return d;
    });
  }

  const workspaceRoot = opts.workspaceRoot ?? cwd;
  let baseline: { gitHead: string | null; dirtyFiles: string[]; dirtyFileHashes: Record<string, string | null> } = {
    gitHead: null,
    dirtyFiles: [],
    dirtyFileHashes: {},
  };
  try {
    baseline = await captureBaseline(workspaceRoot);
  } catch {
    // non-git or capture failure — continue without baseline
  }

  const startedAt = new Date().toISOString();
  doc = await updatePlanDocument(cwd, (d) => {
    d.status = "executing";
    if (d.steps) {
      d.steps = d.steps.map((s, i) => ({
        ...s,
        status: i === 0 ? ("doing" as const) : ("todo" as const),
      }));
    }
    d.execution = {
      startedAt,
      finishedAt: undefined,
      error: undefined,
      lastResultSummary: undefined,
      changedFiles: undefined,
      missingPlannedFiles: undefined,
      unplannedFiles: undefined,
      auditReport: undefined,
      baseline,
    };
    return d;
  });

  return {
    document: doc,
    executionPromptSuffix: getExecutionPromptSuffix(doc),
  };
}

export async function markPlanExecutionResult(
  cwd: string,
  result: {
    ok: boolean;
    summary?: string;
    error?: string;
    /** Real project workspace for git audit (not session plan store path). */
    workspaceRoot?: string;
  },
): Promise<PlanDocument> {
  const existing = await loadPlanDocument(cwd);
  if (!existing) throw new Error("No plan found");

  const workspaceRoot = result.workspaceRoot ?? existing.cwd;
  let audit: Awaited<ReturnType<typeof runExecutionAudit>> | undefined;
  try {
    audit = await runExecutionAudit({
      plannedFiles: existing.files,
      steps: existing.steps,
      workspaceRoot,
      executionOk: result.ok,
      baseline: existing.execution?.baseline,
    });
  } catch {
    audit = undefined;
  }

  const finishedAt = new Date().toISOString();
  const summaryParts = [result.summary, audit?.report].filter(Boolean);
  const lastResultSummary = summaryParts.length
    ? summaryParts.join("\n\n")
    : undefined;

  const doc = await updatePlanDocument(cwd, (d) => {
    d.status = result.ok ? "completed" : "failed";
    if (audit && d.steps) {
      const byIndex = new Map(audit.stepUpdates.map((u) => [u.index, u]));
      d.steps = d.steps.map((s) => {
        const u = byIndex.get(s.index);
        return u ? { ...s, status: u.status } : s;
      });
    } else if (result.ok && d.steps) {
      d.steps = d.steps.map((s) => ({ ...s, status: "done" as const }));
    }
    d.execution = {
      ...(d.execution ?? {}),
      finishedAt,
      lastResultSummary,
      error: result.ok ? undefined : (result.error ?? result.summary),
      changedFiles: audit?.changedFiles,
      missingPlannedFiles: audit?.missingPlannedFiles,
      unplannedFiles: audit?.unplannedFiles,
      auditReport: audit?.report,
    };
    return d;
  });

  // Auto-archive a snapshot on successful completion (leave current in place).
  if (result.ok) {
    await archivePlanDocument(cwd, doc);
  }

  return doc;
}

/**
 * Archive a copy of the current plan into history.
 * By default leaves the current plan in place; pass clearCurrent to remove it.
 */
export async function archiveCurrentPlan(
  cwd: string,
  opts: { clearCurrent?: boolean } = {},
): Promise<{ archivedPath: string; document: PlanDocument }> {
  const doc = await loadPlanDocument(cwd);
  if (!doc) throw new Error("No plan found");
  const archivedPath = await archivePlanDocument(cwd, doc);
  if (opts.clearCurrent) {
    await clearPlanDocument(cwd);
  }
  return { archivedPath, document: doc };
}

export { planDocumentToSummary };
