import type { ExecutionPlan, ExecutionStep } from "./types.ts";
import type { ToolResult } from "../tools/types.ts";
import type { PermissionManager, PermissionTurnContext } from "../permissions.ts";
import type { Tool } from "../tools/types.ts";
import { planManager } from "./plan-manager.ts";
import { validatePhaseTransition, logPhaseTransition } from "./state-machine.ts";

/**
 * Executor for execution plans.
 */
export class PlanExecutor {
  private readonly permissionManager: PermissionManager;
  private readonly toolProvider: () => Tool[];
  private readonly options: PlanExecutorOptions;

  constructor(
    permissionManager: PermissionManager,
    toolProvider: () => Tool[],
    options: PlanExecutorOptions = {},
  ) {
    this.permissionManager = permissionManager;
    this.toolProvider = toolProvider;
    this.options = options;
  }

  /**
   * Execute a plan step by step.
   */
  async execute(
    plan: ExecutionPlan,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; completedSteps: ExecutionStep[]; errors: string[] }> {
    const completedSteps: ExecutionStep[] = [];
    const errors: string[] = [];

    // Validate we can execute
    const transition = validatePhaseTransition("review", "acting", { planApproved: true });
    if (!transition.allowed) {
      throw new Error(`Cannot execute plan: ${transition.reason}`);
    }

    // Update plan status
    planManager.updatePlanStatus(plan.id, "executing");
    plan.executionStartedAt = Date.now();

    logPhaseTransition("review", "acting", "Starting plan execution");

    // Emit start event
    this.options.onEvent?.({
      type: "acting_started",
      planId: plan.id,
      sessionId: plan.sessionId,
    });

    try {
      for (const step of plan.steps) {
        // Check abort signal
        if (signal?.aborted) {
          throw new Error("Execution cancelled by user");
        }

        // Execute step
        try {
          const result = await this.executeStep(step, plan, signal);
          completedSteps.push(step);

          this.options.onEvent?.({
            type: "step_completed",
            stepId: step.id,
            planId: plan.id,
            result,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          errors.push(errorMessage);
          step.status = "failed";
          step.error = errorMessage;

          planManager.updateStepStatus(plan.id, step.id, "failed", undefined, errorMessage);

          this.options.onEvent?.({
            type: "step_failed",
            stepId: step.id,
            planId: plan.id,
            error: errorMessage,
          });

          // Handle failure based on configuration
          if (this.options.stopOnError) {
            break;
          }
        }
      }

      // Mark plan as completed or failed
      const allStepsCompleted = plan.steps.every((s) => s.status === "completed");
      if (allStepsCompleted && errors.length === 0) {
        planManager.updatePlanStatus(plan.id, "completed");
        plan.executionCompletedAt = Date.now();
        if (plan.executionStartedAt) {
          plan.executionDurationMs = plan.executionCompletedAt - plan.executionStartedAt;
        }

        this.options.onEvent?.({
          type: "all_steps_completed",
          planId: plan.id,
          sessionId: plan.sessionId,
          durationMs: plan.executionDurationMs ?? 0,
        });
      } else {
        planManager.updatePlanStatus(plan.id, "failed");
        plan.executionCompletedAt = Date.now();

        this.options.onEvent?.({
          type: "execution_failed",
          planId: plan.id,
          sessionId: plan.sessionId,
          error: errors.join("; "),
          completedSteps,
        });
      }

      return {
        success: errors.length === 0,
        completedSteps,
        errors,
      };
    } catch (error) {
      // Handle unexpected errors
      planManager.updatePlanStatus(plan.id, "failed");
      
      this.options.onEvent?.({
        type: "execution_failed",
        planId: plan.id,
        sessionId: plan.sessionId,
        error: error instanceof Error ? error.message : String(error),
        completedSteps,
      });

      throw error;
    }
  }

  /**
   * Execute a single step.
   */
  private async executeStep(
    step: ExecutionStep,
    plan: ExecutionPlan,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    // Validate tool is in approved list
    if (!plan.requiredTools.includes(step.tool)) {
      throw new Error(`Tool '${step.tool}' not approved in plan`);
    }

    // Find tool
    const tools = this.toolProvider();
    const tool = tools.find((t) => t.name === step.tool);
    if (!tool) {
      throw new Error(`Tool '${step.tool}' not found`);
    }

    // Set execution mode
    const executionMode = plan.executionMode ?? "auto";
    this.permissionManager.setMode(executionMode);

    // Begin permission turn
    const turn = this.permissionManager.beginTurn(
      plan.sessionId,
      (request) => {
        // Permission events are handled by PermissionManager directly
      },
      signal,
    );

    try {
      // Emit step started event
      this.options.onEvent?.({
        type: "step_started",
        stepId: step.id,
        planId: plan.id,
        step,
      });

      // Update step status
      step.status = "running";
      step.executedAt = Date.now();
      planManager.updateStepStatus(plan.id, step.id, "running");

      // Execute with permission check
      const result = await turn.execute(tool, step.arguments, signal);

      // Update step status
      step.status = "completed";
      step.result = result;
      step.completedAt = Date.now();
      planManager.updateStepStatus(plan.id, step.id, "completed", result);

      return result;
    } finally {
      turn.close();
    }
  }

  /**
   * Cancel an ongoing execution.
   */
  cancel(planId: string, reason?: string): void {
    const plan = planManager.getPlan(planId);
    if (!plan) return;

    planManager.updatePlanStatus(planId, "failed");
    
    this.options.onEvent?.({
      type: "execution_failed",
      planId,
      sessionId: plan.sessionId,
      error: reason ?? "Execution cancelled",
      completedSteps: plan.steps.filter((s) => s.status === "completed"),
    });
  }

  /**
   * Rollback completed steps (if supported).
   */
  async rollback(plan: ExecutionPlan, completedSteps: ExecutionStep[]): Promise<void> {
    if (!plan.autoRollback) {
      console.warn("[PlanExecutor] Rollback not enabled for this plan");
      return;
    }

    // Execute in reverse order
    for (let i = completedSteps.length - 1; i >= 0; i--) {
      const step = completedSteps[i]!;
      
      // For write operations, we'd need to restore from checkpoint
      // This is a simplified implementation
      console.log(`[PlanExecutor] Rollback step ${i + 1}: ${step.description}`);
    }
  }
}

/**
 * Options for PlanExecutor.
 */
export interface PlanExecutorOptions {
  /** Stop execution on first error. Default: false. */
  stopOnError?: boolean;
  /** Event callback for plan lifecycle events. */
  onEvent?: (event: import("./types.ts").PlanActEvent) => void;
}

/**
 * Create a plan executor with the given dependencies.
 */
export function createPlanExecutor(
  permissionManager: PermissionManager,
  toolProvider: () => Tool[],
  options?: PlanExecutorOptions,
): PlanExecutor {
  return new PlanExecutor(permissionManager, toolProvider, options);
}
