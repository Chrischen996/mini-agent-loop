import type { PermissionMode } from "../permissions.ts";
import type { ToolResult } from "../tools/types.ts";
import type { ToolSource } from "../tools/types.ts";

/**
 * Session phase in the Plan-Act workflow.
 * - planning: Agent is generating an execution plan (read-only)
 * - review: Plan is ready, waiting for user approval
 * - acting: Executing the approved plan
 * - completed: All steps finished successfully
 * - cancelled: User or system cancelled the operation
 */
export type SessionPhase = "planning" | "review" | "acting" | "completed" | "cancelled";

export const SESSION_PHASES: readonly SessionPhase[] = [
  "planning",
  "review",
  "acting",
  "completed",
  "cancelled",
] as const;

export function isSessionPhase(value: unknown): value is SessionPhase {
  return typeof value === "string" && (SESSION_PHASES as readonly string[]).includes(value);
}

/**
 * Risk level for a plan step.
 */
export type PlanStepRisk = "safe" | "medium" | "high";

/**
 * Execution status of a plan step.
 */
export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

/**
 * Category of risk assessment.
 */
export type RiskCategory =
  | "file_modification"
  | "command_execution"
  | "network_access"
  | "mcp_tool"
  | "data_deletion"
  | "other";

/**
 * Risk level for assessment.
 */
export type RiskLevel = "low" | "medium" | "high" | "critical";

/**
 * A single step in an execution plan.
 */
export interface ExecutionStep {
  /** Unique identifier for the step. */
  id: string;
  /** Execution order (1-based). */
  order: number;
  /** Human-readable description. */
  description: string;
  /** Tool name to execute. */
  tool: string;
  /** Tool arguments. */
  arguments: Record<string, unknown>;
  /** Risk level of this step. */
  risk: PlanStepRisk;
  /** Rationale for including this step. */
  rationale: string;
  /** Execution status (filled during Acting phase). */
  status?: StepStatus;
  /** Result of execution (filled when status is completed/failed). */
  result?: ToolResult;
  /** Error message if step failed. */
  error?: string;
  /** Timestamp when step started execution. */
  executedAt?: number;
  /** Timestamp when step completed. */
  completedAt?: number;
  /** Optional dependencies on other step IDs. */
  dependencies?: string[];
}

/**
 * Risk assessment for a plan.
 */
export interface RiskAssessment {
  category: RiskCategory;
  level: RiskLevel;
  description: string;
  mitigation: string;
}

/**
 * Status of the execution plan.
 */
export type PlanStatus =
  | "draft"           // Currently being generated
  | "pending_review"  // Ready for user review
  | "approved"        // User approved
  | "rejected"        // User rejected
  | "modified"        // Modified after generation
  | "executing"       // Currently being executed
  | "completed"       // All steps completed
  | "failed";         // Execution failed

/**
 * A structured execution plan generated during Planning phase.
 */
export interface ExecutionPlan {
  /** Unique plan identifier. */
  id: string;
  /** Session this plan belongs to. */
  sessionId: string;
  /** Plan creation timestamp. */
  createdAt: number;
  
  // ─── Plan Content ───────────────────────────────────────────────
  /** High-level summary of the plan. */
  summary: string;
  /** Execution steps in order. */
  steps: ExecutionStep[];
  /** Risk assessments. */
  risks: RiskAssessment[];
  /** Tools required by this plan. */
  requiredTools: string[];
  
  // ─── Plan State ─────────────────────────────────────────────────
  /** Current status. */
  status: PlanStatus;
  /** Timestamp when plan was reviewed. */
  reviewedAt?: number;
  /** User notes during review. */
  reviewNotes?: string;
  /** Who reviewed the plan (user ID or "auto"). */
  reviewedBy?: string;
  
  // ─── Execution Control ──────────────────────────────────────────
  /** Permission mode for Acting phase. */
  executionMode?: PermissionMode;
  /** Optional whitelist of allowed operations. */
  allowedOperations?: string[];
  /** Overall timeout in seconds. */
  timeoutSeconds?: number;
  /** Per-step timeout in seconds. */
  stepTimeoutSeconds?: number;
  /** Whether to auto-rollback on failure. */
  autoRollback?: boolean;
  
  // ─── Execution Tracking ─────────────────────────────────────────
  /** Number of steps completed. */
  completedSteps?: number;
  /** Number of steps failed. */
  failedSteps?: number;
  /** Total execution time in milliseconds. */
  executionDurationMs?: number;
  /** Timestamp when execution started. */
  executionStartedAt?: number;
  /** Timestamp when execution completed. */
  executionCompletedAt?: number;
  
  // ─── Audit ──────────────────────────────────────────────────────
  /** HMAC signature for tamper detection. */
  signature?: string;
  /** Version for migration tracking. */
  version?: number;
}

/**
 * Request to approve a plan.
 */
export interface PlanApprovalRequest {
  planId: string;
  /** User notes or feedback. */
  notes?: string;
  /** Override execution mode. */
  executionMode?: PermissionMode;
}

/**
 * Event emitted during Plan-Act workflow.
 */
export type PlanActEvent =
  | { type: "planning_started"; sessionId: string }
  | { type: "plan_generated"; plan: ExecutionPlan }
  | { type: "plan_approved"; planId: string; sessionId: string; notes?: string }
  | { type: "plan_rejected"; planId: string; sessionId: string; reason?: string }
  | { type: "plan_modified"; plan: ExecutionPlan }
  | { type: "acting_started"; planId: string; sessionId: string }
  | { type: "step_started"; stepId: string; planId: string; step: ExecutionStep }
  | { type: "step_completed"; stepId: string; planId: string; result: ToolResult }
  | { type: "step_failed"; stepId: string; planId: string; error: string }
  | { type: "all_steps_completed"; planId: string; sessionId: string; durationMs: number }
  | { type: "execution_failed"; planId: string; sessionId: string; error: string; completedSteps: ExecutionStep[] }
  | { type: "phase_changed"; sessionId: string; from: SessionPhase; to: SessionPhase };

/**
 * Result of a phase transition validation.
 */
export interface PhaseTransitionResult {
  allowed: boolean;
  from: SessionPhase;
  to: SessionPhase;
  reason?: string;
}

/**
 * Context for plan generation.
 */
export interface PlanGenerationContext {
  sessionId: string;
  userPrompt: string;
  history: Array<{ role: string; content: string }>;
  existingPlan?: ExecutionPlan;
}

/**
 * Parsed plan from LLM output.
 */
export interface ParsedPlan {
  summary: string;
  steps: Array<Omit<ExecutionStep, "id"> & { id?: string }>;
  risks: RiskAssessment[];
  requiredTools: string[];
  /** Whether parsing was successful. */
  valid: boolean;
  /** Error message if invalid. */
  error?: string;
}
