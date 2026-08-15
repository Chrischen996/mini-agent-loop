import { randomUUID } from "node:crypto";
import type { ExecutionPlan, PlanStatus, SessionPhase } from "./types.ts";
import { validatePhaseTransition, logPhaseTransition } from "./state-machine.ts";

/**
 * Manages execution plans for sessions.
 */
export class PlanManager {
  private readonly plans = new Map<string, ExecutionPlan>();
  private readonly sessionPlans = new Map<string, string[]>(); // sessionId -> planIds

  /**
   * Create a new draft plan.
   */
  createPlan(sessionId: string, summary: string, steps: ExecutionPlan["steps"]): ExecutionPlan {
    const plan: ExecutionPlan = {
      id: `plan_${randomUUID()}`,
      sessionId,
      createdAt: Date.now(),
      summary,
      steps,
      risks: [],
      requiredTools: [...new Set(steps.map((s) => s.tool))],
      status: "draft",
      version: 1,
    };

    this.plans.set(plan.id, plan);
    
    const sessionPlanIds = this.sessionPlans.get(sessionId) ?? [];
    sessionPlanIds.push(plan.id);
    this.sessionPlans.set(sessionId, sessionPlanIds);

    return plan;
  }

  /**
   * Get a plan by ID.
   */
  getPlan(planId: string): ExecutionPlan | undefined {
    return this.plans.get(planId);
  }

  /**
   * Get the current plan for a session.
   */
  getCurrentPlan(sessionId: string): ExecutionPlan | undefined {
    const planIds = this.sessionPlans.get(sessionId) ?? [];
    // Return the most recent non-rejected plan
    for (let i = planIds.length - 1; i >= 0; i--) {
      const plan = this.plans.get(planIds[i]);
      if (plan && plan.status !== "rejected") {
        return plan;
      }
    }
    return undefined;
  }

  /**
   * Get all plans for a session.
   */
  getSessionPlans(sessionId: string): ExecutionPlan[] {
    const planIds = this.sessionPlans.get(sessionId) ?? [];
    return planIds
      .map((id) => this.plans.get(id))
      .filter((plan): plan is ExecutionPlan => plan !== undefined);
  }

  /**
   * Update plan status with validation.
   */
  updatePlanStatus(
    planId: string,
    newStatus: PlanStatus,
    context?: Record<string, unknown>,
  ): ExecutionPlan | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;

    // Validate status transition
    const allowedTransitions: Record<PlanStatus, PlanStatus[]> = {
      draft: ["pending_review", "modified"],
      pending_review: ["approved", "rejected", "modified"],
      approved: ["executing", "modified"],
      rejected: ["modified", "draft"],
      modified: ["pending_review", "draft"],
      executing: ["completed", "failed", "modified"],
      completed: [],
      failed: ["modified"],
    };

    const allowed = allowedTransitions[plan.status]?.includes(newStatus);
    if (!allowed) {
      console.warn(`[PlanManager] Invalid status transition: ${plan.status} → ${newStatus}`);
      return null;
    }

    plan.status = newStatus;

    // Update timestamps
    if (newStatus === "approved") {
      plan.reviewedAt = Date.now();
      plan.executionStartedAt = Date.now();
    }
    if (newStatus === "completed" || newStatus === "failed") {
      plan.executionCompletedAt = Date.now();
      if (plan.executionStartedAt) {
        plan.executionDurationMs = plan.executionCompletedAt - plan.executionStartedAt;
      }
    }

    // Plan status transitions logged separately
    const _ = `${plan.status} → ${newStatus}`;
    return plan;
  }

  /**
   * Mark plan as ready for review.
   */
  markPendingReview(planId: string): ExecutionPlan | null {
    return this.updatePlanStatus(planId, "pending_review");
  }

  /**
   * Approve a plan.
   */
  approvePlan(planId: string, options?: { executionMode?: string; notes?: string }): ExecutionPlan | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;

    if (options?.executionMode) {
      plan.executionMode = options.executionMode as ExecutionPlan["executionMode"];
    }
    if (options?.notes) {
      plan.reviewNotes = options.notes;
      plan.reviewedBy = options.notes;
    }

    const result = this.updatePlanStatus(planId, "approved");
    return result;
  }

  /**
   * Reject a plan.
   */
  rejectPlan(planId: string, reason?: string): ExecutionPlan | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;
    
    if (reason) {
      plan.reviewNotes = `Rejected: ${reason}`;
    }

    return this.updatePlanStatus(planId, "rejected");
  }

  /**
   * Update plan steps.
   */
  updateSteps(planId: string, steps: ExecutionPlan["steps"]): ExecutionPlan | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;

    plan.steps = steps;
    plan.requiredTools = [...new Set(steps.map((s) => s.tool))];
    
    // Reset status if steps change
    if (plan.status === "approved" || plan.status === "executing") {
      plan.status = "modified";
    }

    return plan;
  }

  /**
   * Update step status during execution.
   */
  updateStepStatus(
    planId: string,
    stepId: string,
    status: ExecutionPlan["steps"][number]["status"],
    result?: ExecutionPlan["steps"][number]["result"],
    error?: string,
  ): ExecutionPlan | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;

    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) return null;

    step.status = status;
    if (result) step.result = result;
    if (error) step.error = error;
    if (status === "completed" || status === "failed") {
      step.completedAt = Date.now();
    }

    // Update counters
    plan.completedSteps = plan.steps.filter((s) => s.status === "completed").length;
    plan.failedSteps = plan.steps.filter((s) => s.status === "failed").length;

    return plan;
  }

  /**
   * Delete a plan.
   */
  deletePlan(planId: string): boolean {
    const plan = this.plans.get(planId);
    if (!plan) return false;

    const sessionPlanIds = this.sessionPlans.get(plan.sessionId) ?? [];
    const index = sessionPlanIds.indexOf(planId);
    if (index >= 0) {
      sessionPlanIds.splice(index, 1);
      this.sessionPlans.set(plan.sessionId, sessionPlanIds);
    }

    this.plans.delete(planId);
    return true;
  }

  /**
   * Serialize plan to JSON.
   */
  serialize(plan: ExecutionPlan): string {
    return JSON.stringify(plan, null, 2);
  }

  /**
   * Deserialize plan from JSON.
   */
  deserialize(json: string): ExecutionPlan | null {
    try {
      const plan = JSON.parse(json) as ExecutionPlan;
      
      // Validate required fields
      if (!plan.id || !plan.sessionId || !plan.steps) {
        return null;
      }

      // Set defaults
      plan.version ??= 1;
      plan.risks ??= [];
      plan.requiredTools ??= [];

      return plan;
    } catch {
      return null;
    }
  }

  /**
   * Get plan count for a session.
   */
  getPlanCount(sessionId: string): number {
    return (this.sessionPlans.get(sessionId) ?? []).length;
  }

  /**
   * Clear all plans for a session.
   */
  clearSessionPlans(sessionId: string): void {
    const planIds = this.sessionPlans.get(sessionId) ?? [];
    for (const id of planIds) {
      this.plans.delete(id);
    }
    this.sessionPlans.delete(sessionId);
  }
}

/**
 * Singleton instance for global access.
 */
export const planManager = new PlanManager();
