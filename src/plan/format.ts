/**
 * Plan document formatting helpers — previews and simple diffs.
 */

import { formatPlanPreview, parsePlan } from "../plan-formatter.ts";
import {
  planDocumentToSummary,
  type PlanDocument,
  type PlanStepStatus,
} from "./document.ts";

const STEP_STATUS_ICON: Record<PlanStepStatus, string> = {
  todo: "☐",
  doing: "…",
  done: "✓",
  skipped: "⊘",
  failed: "✗",
};

/**
 * Richer console preview for a full PlanDocument (metadata + steps + audit).
 */
export function formatPlanDocumentPreview(doc: PlanDocument): string {
  const lines: string[] = [];
  lines.push("═".repeat(60));
  lines.push(`  📋 PLAN DOCUMENT`);
  lines.push("═".repeat(60));
  lines.push(`  id:        ${doc.id}`);
  lines.push(`  status:    ${doc.status}`);
  if (doc.approvedBy) {
    lines.push(`  approvedBy: ${doc.approvedBy}`);
  }
  lines.push(`  createdAt: ${doc.createdAt}`);
  lines.push(`  updatedAt: ${doc.updatedAt}`);
  if (doc.execution) {
    lines.push("  execution:");
    if (doc.execution.startedAt) {
      lines.push(`    startedAt:  ${doc.execution.startedAt}`);
    }
    if (doc.execution.finishedAt) {
      lines.push(`    finishedAt: ${doc.execution.finishedAt}`);
    }
    if (doc.execution.error) {
      lines.push(`    error:      ${doc.execution.error}`);
    }
    if (doc.execution.lastResultSummary) {
      const s = doc.execution.lastResultSummary;
      lines.push(
        `    summary:    ${s.slice(0, 120)}${s.length > 120 ? "…" : ""}`,
      );
    }
    if (doc.execution.changedFiles?.length) {
      lines.push(
        `    changed:    ${doc.execution.changedFiles.join(", ")}`,
      );
    }
    if (doc.execution.missingPlannedFiles?.length) {
      lines.push(
        `    missing:    ${doc.execution.missingPlannedFiles.join(", ")}`,
      );
    }
    if (doc.execution.unplannedFiles?.length) {
      lines.push(
        `    unplanned:  ${doc.execution.unplannedFiles.join(", ")}`,
      );
    }
  }

  if (doc.steps && doc.steps.length > 0) {
    lines.push("");
    lines.push("── Steps (status) ──");
    for (const s of doc.steps) {
      const st = s.status ?? "todo";
      const icon = STEP_STATUS_ICON[st] ?? "·";
      const files =
        s.files && s.files.length > 0 ? ` → ${s.files.join(", ")}` : "";
      lines.push(`  ${icon} ${s.index}. [${st}] ${s.text}${files}`);
    }
  }

  if (doc.execution?.auditReport) {
    lines.push("");
    lines.push(doc.execution.auditReport);
  }

  lines.push("");
  lines.push(formatPlanPreview(planDocumentToSummary(doc)));
  return lines.join("\n");
}

/**
 * Simple step-level text diff between two plan markdown bodies.
 * Lists removed steps, added steps, and file-set changes.
 */
export function formatPlanDiff(
  beforeMarkdown: string,
  afterMarkdown: string,
  prompt: string,
): string {
  const before = parsePlan(prompt, beforeMarkdown);
  const after = parsePlan(prompt, afterMarkdown);

  const beforeTexts = new Set(before.steps.map((s) => s.text.trim()));
  const afterTexts = new Set(after.steps.map((s) => s.text.trim()));

  const removed = before.steps.filter((s) => !afterTexts.has(s.text.trim()));
  const added = after.steps.filter((s) => !beforeTexts.has(s.text.trim()));

  const beforeFiles = new Set(before.files);
  const afterFiles = new Set(after.files);
  const filesRemoved = before.files.filter((f) => !afterFiles.has(f));
  const filesAdded = after.files.filter((f) => !beforeFiles.has(f));

  const lines: string[] = [];
  lines.push("── Plan Diff ──");

  if (
    removed.length === 0 &&
    added.length === 0 &&
    filesRemoved.length === 0 &&
    filesAdded.length === 0
  ) {
    lines.push("  (no step or file changes detected)");
    return lines.join("\n");
  }

  if (removed.length > 0) {
    lines.push(`  Removed steps (${removed.length}):`);
    for (const s of removed) {
      lines.push(`    - ${s.index}. ${s.text}`);
    }
  }

  if (added.length > 0) {
    lines.push(`  Added steps (${added.length}):`);
    for (const s of added) {
      lines.push(`    + ${s.index}. ${s.text}`);
    }
  }

  if (filesRemoved.length > 0 || filesAdded.length > 0) {
    lines.push("  File set changes:");
    for (const f of filesRemoved) {
      lines.push(`    - ${f}`);
    }
    for (const f of filesAdded) {
      lines.push(`    + ${f}`);
    }
  }

  return lines.join("\n");
}
