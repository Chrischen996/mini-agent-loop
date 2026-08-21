import type { AgentMessage } from "../types.ts";

export type JobStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type JobKind = "agent_turn" | "planner_worker_reviewer";

export type WorkOrder = {
  id: string;
  goal: string;
  plan: string[];
  acceptanceCriteria: string[];
  workerProfile: string;
  reviewerProfile: string;
  workspace: string;
  constraints: string[];
  createdAt: number;
};

export type WorkerReport = {
  status: "completed" | "failed" | "blocked";
  summary: string;
  changedFiles: string[];
  validation: string[];
  evidence?: string[];
  questions: string[];
};

export type ReviewReport = {
  decision: "pass" | "rework" | "blocked";
  findings: string[];
  requiredChanges: string[];
  evidence: string[];
};

export type OrchestrationEvent = {
  type: string;
  at: number;
  message?: string;
  data?: Record<string, unknown>;
};

export type OrchestrationJob = {
  id: string;
  sessionId: string;
  kind: JobKind;
  task: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  result?: string;
  events: OrchestrationEvent[];
  workOrder?: WorkOrder;
  workerReport?: WorkerReport;
  reviewReport?: ReviewReport;
  messages?: AgentMessage[];
};

const transitions: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["waiting_approval", "paused", "completed", "failed", "cancelled"],
  waiting_approval: ["running", "paused", "completed", "failed", "cancelled"],
  paused: ["running", "completed", "cancelled", "failed"],
  completed: [],
  failed: ["queued"],
  cancelled: [],
};

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return transitions[from].includes(to);
}

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransitionJob(from, to)) {
    throw new Error(`Invalid orchestration job transition: ${from} -> ${to}`);
  }
}
