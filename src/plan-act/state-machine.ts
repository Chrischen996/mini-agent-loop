import type { SessionPhase, PhaseTransitionResult } from "./types.ts";

export type { SessionPhase } from "./types.ts";

/**
 * Valid phase transitions with their conditions.
 */
const TRANSITION_RULES: Record<
  SessionPhase,
  Array<{ to: SessionPhase; condition?: string; reason?: string }>
> = {
  planning: [
    { to: "review", condition: "plan_generated", reason: "Plan generation complete" },
    { to: "planning", condition: "continue_planning", reason: "Continuing to gather information" },
    { to: "cancelled", condition: "user_cancelled", reason: "User cancelled during planning" },
  ],
  review: [
    { to: "acting", condition: "plan_approved", reason: "Plan approved by user" },
    { to: "planning", condition: "plan_modified", reason: "User requested plan modifications" },
    { to: "cancelled", condition: "plan_rejected", reason: "Plan rejected by user" },
  ],
  acting: [
    { to: "acting", condition: "step_completed", reason: "Step completed, continuing" },
    { to: "completed", condition: "all_steps_completed", reason: "All steps completed successfully" },
    { to: "review", condition: "need_replan", reason: "Execution requires replanning" },
    { to: "cancelled", condition: "execution_cancelled", reason: "Execution cancelled by user or system" },
  ],
  completed: [],
  cancelled: [],
};

/**
 * Validates whether a phase transition is allowed.
 */
export function validatePhaseTransition(
  from: SessionPhase,
  to: SessionPhase,
  context?: Record<string, unknown>,
): PhaseTransitionResult {
  // Same phase is always allowed (no-op)
  if (from === to) {
    return { allowed: true, from, to, reason: "No transition needed" };
  }

  // Terminal states cannot transition
  if (from === "completed" || from === "cancelled") {
    return {
      allowed: false,
      from,
      to,
      reason: `Cannot transition from terminal state '${from}'`,
    };
  }

  // Check valid transitions
  const rules = TRANSITION_RULES[from];
  if (!rules) {
    return {
      allowed: false,
      from,
      to,
      reason: `Unknown source phase '${from}'`,
    };
  }

  const validTransition = rules.find((r) => r.to === to);
  if (!validTransition) {
    const allowedTargets = rules.map((r) => r.to).join(", ");
    return {
      allowed: false,
      from,
      to,
      reason: `Invalid transition from '${from}' to '${to}'. Allowed: ${allowedTargets}`,
    };
  }

  // Check condition if specified
  if (validTransition.condition && context) {
    const conditionMet = checkCondition(validTransition.condition, context);
    if (!conditionMet) {
      return {
        allowed: false,
        from,
        to,
        reason: `Condition '${validTransition.condition}' not met`,
      };
    }
  }

  return {
    allowed: true,
    from,
    to,
    reason: validTransition.reason,
  };
}

/**
 * Check if a named condition is satisfied by the context.
 */
function checkCondition(
  condition: string,
  context: Record<string, unknown>,
): boolean {
  switch (condition) {
    case "plan_generated":
      return !!context.plan;
    case "plan_approved":
      return !!context.approved;
    case "plan_rejected":
      return !!context.rejected;
    case "plan_modified":
      return !!context.modified;
    case "all_steps_completed":
      return !!context.allCompleted;
    case "need_replan":
      return !!context.needReplan;
    case "user_cancelled":
    case "execution_cancelled":
      return !!context.cancelled;
    default:
      // Unknown conditions are considered met (permissive)
      return true;
  }
}

/**
 * Get all possible next phases from a given phase.
 */
export function getValidNextPhases(phase: SessionPhase): SessionPhase[] {
  const rules = TRANSITION_RULES[phase];
  if (!rules) return [];
  return [...new Set(rules.map((r) => r.to))];
}

/**
 * Check if a phase is terminal.
 */
export function isTerminalPhase(phase: SessionPhase): boolean {
  return phase === "completed" || phase === "cancelled";
}

/**
 * Check if planning can proceed from a phase.
 */
export function canProceedToPlanning(phase: SessionPhase): boolean {
  return phase === "planning" || phase === "review";
}

/**
 * Check if execution can proceed from a phase.
 */
export function canProceedToActing(phase: SessionPhase): boolean {
  return phase === "review";
}

/**
 * Create a new session with initial planning phase.
 */
export function createInitialPhase(): SessionPhase {
  return "planning";
}

/**
 * Apply a phase transition and return the new phase.
 * Throws if the transition is not allowed.
 */
export function applyPhaseTransition(
  current: SessionPhase,
  target: SessionPhase,
  context?: Record<string, unknown>,
): SessionPhase {
  const result = validatePhaseTransition(current, target, context);
  if (!result.allowed) {
    throw new Error(`Phase transition blocked: ${result.reason}`);
  }
  return target;
}

/**
 * Phase transition logger for debugging.
 */
export function logPhaseTransition(
  from: SessionPhase,
  to: SessionPhase,
  reason?: string,
): void {
  const timestamp = new Date().toISOString();
  console.log(`[PlanAct] ${timestamp} Phase: ${from} → ${to}${reason ? ` (${reason})` : ""}`);
}
