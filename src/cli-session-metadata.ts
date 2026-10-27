import type { ExecutionPlan, SessionPhase } from "./plan-act/types.ts";

export function createCliSessionMetadata(initial: {
  phase?: SessionPhase;
  currentPlan?: ExecutionPlan;
}) {
  let phase = initial.phase;
  let currentPlan = initial.currentPlan;

  return {
    snapshot: () => ({ phase, currentPlan }),
    onPlanEvent: (event: import("./plan-act/types.ts").PlanActEvent) => {
      switch (event.type) {
        case "planning_started":
          phase = "planning";
          break;
        case "phase_changed":
          phase = event.to;
          break;
        case "plan_generated":
          phase = "review";
          currentPlan = event.plan;
          break;
        case "plan_modified":
          phase = "planning";
          currentPlan = event.plan;
          break;
      }
    },
  };
}
