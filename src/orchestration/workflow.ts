import { randomUUID } from "node:crypto";
import type { ReviewReport, WorkOrder, WorkerReport } from "./types.ts";

export type WorkflowStage = "intake" | "planning" | "executing" | "reviewing" | "reworking" | "completed" | "blocked";

export type WorkflowState = {
  stage: WorkflowStage;
  workOrder: WorkOrder;
  workerReport?: WorkerReport;
  reviewReport?: ReviewReport;
  reworkCount: number;
};

export type WorkflowStateChange = (state: WorkflowState) => void | Promise<void>;

export type WorkflowEvidence = {
  changedFiles: string[];
  validation: string[];
  evidence: string[];
};

export type WorkflowEvidenceCollector = (input: {
  workOrder: WorkOrder;
  workerReport: WorkerReport;
  reworkCount: number;
}) => Promise<WorkflowEvidence>;

export function createWorkOrder(input: Omit<WorkOrder, "id" | "createdAt">): WorkOrder {
  return { ...input, id: `work_${randomUUID()}`, createdAt: Date.now() };
}

export type WorkflowInvoker = (input: { profile: string; task: string; sharedContext: string }) => Promise<string>;

export async function runPlannerWorkerReviewer(input: {
  goal: string;
  workspace: string;
  acceptanceCriteria: string[];
  constraints?: string[];
  invoke: WorkflowInvoker;
  collectEvidence?: WorkflowEvidenceCollector;
  maxReworks?: number;
  onStateChange?: WorkflowStateChange;
}): Promise<WorkflowState> {
  const workOrder = createWorkOrder({
    goal: input.goal,
    plan: [],
    acceptanceCriteria: input.acceptanceCriteria,
    workerProfile: "coder",
    reviewerProfile: "reviewer",
    workspace: input.workspace,
    constraints: input.constraints ?? [],
  });
  const state: WorkflowState = { stage: "planning", workOrder, reworkCount: 0 };
  const notify = async (): Promise<void> => {
    await input.onStateChange?.(state);
  };
  await notify();
  const plan = await input.invoke({
    profile: "researcher",
    task: `Create a concise implementation plan for: ${input.goal}`,
    sharedContext: JSON.stringify(workOrder),
  });
  workOrder.plan = plan.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 20);
  await notify();

  for (;;) {
    state.stage = "executing";
    await notify();
    const workerText = await input.invoke({
      profile: workOrder.workerProfile,
      task: input.goal,
      sharedContext: JSON.stringify({ workOrder, review: state.reviewReport }),
    });
    const workerReport: WorkerReport = {
      status: "completed",
      summary: workerText,
      changedFiles: [],
      validation: [],
      questions: [],
    };
    const evidence = await input.collectEvidence?.({
      workOrder,
      workerReport,
      reworkCount: state.reworkCount,
    });
    state.workerReport = evidence
      ? { ...workerReport, ...evidence }
      : workerReport;

    state.stage = "reviewing";
    await notify();
    const reviewText = await input.invoke({
      profile: workOrder.reviewerProfile,
      task: "Review the worker result against the acceptance criteria. Return PASS, REWORK, or BLOCKED followed by findings.",
      sharedContext: JSON.stringify({ workOrder, workerReport: state.workerReport }),
    });
    const decision = parseReviewDecision(reviewText);
    state.reviewReport = {
      decision,
      findings: [reviewText],
      requiredChanges: decision === "rework" ? [reviewText] : [],
      evidence: state.workerReport.evidence ?? [],
    };
    if (decision === "pass") {
      state.stage = "completed";
      await notify();
      return state;
    }
    if (decision === "blocked" || state.reworkCount >= (input.maxReworks ?? 2)) {
      state.stage = "blocked";
      await notify();
      return state;
    }
    state.reworkCount += 1;
    state.stage = "reworking";
    await notify();
  }
}

export function parseReviewDecision(reviewText: string): ReviewReport["decision"] {
  const heading = reviewText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const explicit = heading?.match(/^(PASS|REWORK|BLOCKED)\b/i)?.[1]?.toLowerCase();
  if (explicit === "pass" || explicit === "rework" || explicit === "blocked") return explicit;
  // A reviewer that does not provide a machine-readable decision is unsafe to
  // treat as approval; the caller must inspect or retry the workflow.
  return "blocked";
}
