/**
 * Plan approval — interactive workflow between plan generation and execution.
 *
 * Shows a formatted preview of the generated plan, then prompts the user
 * to approve, reject, or edit before proceeding.
 *
 * Non-interactive mode (--yes or CI): auto-approves without prompting.
 */

import { createInterface } from "node:readline";
import type { PlanSummary } from "./plan-formatter.ts";
import { formatPlanPreview, parsePlan } from "./plan-formatter.ts";
import type { PlanFile } from "./plan-persist.ts";
import { planDocumentToSummary, type PlanDocument } from "./plan/index.ts";

export type ApprovalDecision =
  | { kind: "approve" }
  | { kind: "reject" }
  | { kind: "edit"; modifiedPlan: string };

/**
 * Show a plan preview and prompt for approval.
 * Returns "approve" in non-interactive contexts (CI, --yes).
 */
export async function approvePlan(
  summary: PlanSummary,
  options: { yes?: boolean; quiet?: boolean } = {},
): Promise<ApprovalDecision> {
  // Non-interactive / --yes: auto-approve
  if (options.yes || !process.stdin.isTTY) {
    if (!options.quiet) {
      console.error(formatPlanPreview(summary));
    }
    return { kind: "approve" };
  }

  // Interactive: show preview + prompt
  console.error(formatPlanPreview(summary));
  console.error("");
  console.error("  Approve this plan? (y)es / (n)o / (e)dit");
  console.error("  Enter your choice:");

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise<ApprovalDecision>((resolve) => {
    rl.question("  > ", (answer) => {
      rl.close();
      const choice = answer.trim().toLowerCase();
      if (choice === "n" || choice === "no") {
        resolve({ kind: "reject" });
      } else if (choice === "e" || choice === "edit") {
        resolve({
          kind: "edit",
          modifiedPlan: summary.raw, // will be replaced by editor flow
        });
      } else {
        // y, yes, empty = approve
        resolve({ kind: "approve" });
      }
    });
  });
}

/**
 * Run the full plan-then-execute approval workflow.
 *
 * 1. Generate plan (plan mode agent run)
 * 2. Show preview + ask for approval
 * 3. Execute if approved, skip if rejected
 */
export type PlanWorkflowResult =
  | { kind: "approved"; plan: PlanFile; summary: PlanSummary }
  | { kind: "rejected" }
  | { kind: "skipped"; reason: string };

/**
 * Format a PlanFile into a PlanSummary for display.
 */
export function planFileToSummary(plan: PlanFile): PlanSummary {
  return parsePlan(plan.prompt, plan.plan);
}

/**
 * Format a PlanDocument into a PlanSummary for display.
 */
export function planDocumentToApprovalSummary(doc: PlanDocument): PlanSummary {
  return planDocumentToSummary(doc);
}
