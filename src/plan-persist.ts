/**
 * Plan persistence — compatibility layer over the plan workflow kernel.
 *
 * Stage 1 (--plan): agent runs in plan mode, output + metadata saved
 * Stage 2 (--plan-execute): reads saved plan, runs in bypass mode with plan context
 */

import path from "node:path";
import {
  approveCurrentPlan,
  clearPlanDocument,
  createAndSavePlan,
  documentToLegacyPlanFile,
  LEGACY_PLAN_FILENAME,
  loadPlanDocument,
  rejectCurrentPlan,
  type PlanFile,
} from "./plan/index.ts";

export type { PlanFile };

export async function savePlan(
  cwd: string,
  prompt: string,
  plan: string,
  options: { approval?: PlanFile["approval"]; approvedBy?: string } = {},
): Promise<string> {
  const approval = options.approval ?? "pending";
  await createAndSavePlan(cwd, prompt, plan, {
    autoApprove: approval === "approved",
    approvedBy: options.approvedBy ?? (approval === "approved" ? "auto" : undefined),
  });

  // If caller requested rejected (unusual), set it after create
  if (approval === "rejected") {
    await rejectCurrentPlan(cwd);
  } else if (approval === "approved" && options.approvedBy) {
    // ensure approvedBy is exactly what caller passed
    await approveCurrentPlan(cwd, options.approvedBy);
  }

  // Tests assert the returned path ends with the legacy filename
  return path.join(cwd, LEGACY_PLAN_FILENAME);
}

/** Mark a plan as approved by a user. */
export async function approvePlanAt(cwd: string, by: string): Promise<void> {
  await approveCurrentPlan(cwd, by);
}

/** Mark a plan as rejected. */
export async function rejectPlanAt(cwd: string): Promise<void> {
  await rejectCurrentPlan(cwd);
}

export async function loadPlan(cwd: string): Promise<PlanFile | null> {
  const doc = await loadPlanDocument(cwd);
  if (!doc) return null;
  return documentToLegacyPlanFile(doc);
}

export async function clearPlan(cwd: string): Promise<void> {
  await clearPlanDocument(cwd);
}
