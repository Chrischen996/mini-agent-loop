import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCliSessionMetadata } from "../src/cli-session-metadata.ts";
import type { ExecutionPlan } from "../src/plan-act/types.ts";

describe("CLI session snapshot metadata", () => {
  it("updates phase and plan from Plan-Act events", () => {
    const initialPlan: ExecutionPlan = {
      id: "old",
      sessionId: "session-1",
      createdAt: 1,
      summary: "old task",
      steps: [],
      risks: [],
      requiredTools: [],
      status: "draft",
    };
    const generatedPlan: ExecutionPlan = {
      ...initialPlan,
      id: "new",
      summary: "new task",
      status: "pending_review",
    };
    const modifiedPlan: ExecutionPlan = { ...generatedPlan, summary: "revised task" };
    const metadata = createCliSessionMetadata({
      currentPlan: initialPlan,
    });

    metadata.onPlanEvent({ type: "planning_started", sessionId: "session-1" });
    assert.deepEqual(metadata.snapshot(), { phase: "planning", currentPlan: initialPlan });

    metadata.onPlanEvent({ type: "plan_generated", plan: generatedPlan });
    assert.deepEqual(metadata.snapshot(), { phase: "review", currentPlan: generatedPlan });

    metadata.onPlanEvent({
      type: "phase_changed",
      sessionId: "session-1",
      from: "review",
      to: "acting",
    });
    assert.deepEqual(metadata.snapshot(), { phase: "acting", currentPlan: generatedPlan });

    metadata.onPlanEvent({ type: "plan_modified", plan: modifiedPlan });
    assert.deepEqual(metadata.snapshot(), { phase: "planning", currentPlan: modifiedPlan });
  });
});
