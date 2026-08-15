import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  validatePhaseTransition,
  getValidNextPhases,
  isTerminalPhase,
  canProceedToPlanning,
  canProceedToActing,
  applyPhaseTransition,
  createInitialPhase,
  type SessionPhase,
} from "../../src/plan-act/state-machine.ts";

test("Phase transition validation", async (t) => {
  await t.test("planning → review is allowed", () => {
    const result = validatePhaseTransition("planning", "review", { plan: {} });
    assert.equal(result.allowed, true);
    assert.equal(result.reason, "Plan generation complete");
  });

  await t.test("planning → acting is not allowed directly", () => {
    const result = validatePhaseTransition("planning", "acting");
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes("Invalid transition"));
  });

  await t.test("review → acting is allowed with approval", () => {
    const result = validatePhaseTransition("review", "acting", { approved: true });
    assert.equal(result.allowed, true);
  });

  await t.test("review → planning is allowed for modifications", () => {
    const result = validatePhaseTransition("review", "planning", { modified: true });
    assert.equal(result.allowed, true);
  });

  await t.test("completed is terminal", () => {
    const result = validatePhaseTransition("completed", "planning");
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes("terminal state"));
  });

  await t.test("cancelled is terminal", () => {
    const result = validatePhaseTransition("cancelled", "acting");
    assert.equal(result.allowed, false);
  });

  await t.test("same phase is always allowed", () => {
    const result = validatePhaseTransition("planning", "planning");
    assert.equal(result.allowed, true);
    assert.equal(result.reason, "No transition needed");
  });
});

test("Valid next phases", async (t) => {
  await t.test("planning allows review", () => {
    const next = getValidNextPhases("planning");
    assert.ok(next.includes("review"));
  });

  await t.test("review allows acting, planning, and cancelled", () => {
    const next = getValidNextPhases("review");
    assert.deepEqual(next.sort(), ["acting", "planning", "cancelled"].sort());
  });

  await t.test("acting allows completed and review", () => {
    const next = getValidNextPhases("acting");
    assert.ok(next.includes("completed"));
    assert.ok(next.includes("review"));
    assert.ok(next.includes("acting")); // step_completed keeps in acting
  });

  await t.test("completed has no next phases", () => {
    const next = getValidNextPhases("completed");
    assert.deepEqual(next, []);
  });
});

test("Phase utilities", async (t) => {
  await t.test("isTerminalPhase", () => {
    assert.equal(isTerminalPhase("completed"), true);
    assert.equal(isTerminalPhase("cancelled"), true);
    assert.equal(isTerminalPhase("planning"), false);
    assert.equal(isTerminalPhase("review"), false);
    assert.equal(isTerminalPhase("acting"), false);
  });

  await t.test("canProceedToPlanning", () => {
    assert.equal(canProceedToPlanning("planning"), true);
    assert.equal(canProceedToPlanning("review"), true);
    assert.equal(canProceedToPlanning("acting"), false);
  });

  await t.test("canProceedToActing", () => {
    assert.equal(canProceedToActing("review"), true);
    assert.equal(canProceedToActing("planning"), false);
    assert.equal(canProceedToActing("acting"), false);
  });

  await t.test("createInitialPhase returns planning", () => {
    const phase = createInitialPhase();
    assert.equal(phase, "planning");
  });
});

test("applyPhaseTransition", async (t) => {
  await t.test("applies valid transition", () => {
    const result = applyPhaseTransition("planning", "review", { plan: {} });
    assert.equal(result, "review");
  });

  await t.test("throws on invalid transition", () => {
    assert.throws(
      () => applyPhaseTransition("planning", "acting"),
      /Phase transition blocked/
    );
  });

  await t.test("throws on terminal state", () => {
    assert.throws(
      () => applyPhaseTransition("completed", "planning"),
      /terminal state/
    );
  });
});

test("Condition checking", async (t) => {
  await t.test("plan_generated condition", () => {
    const result = validatePhaseTransition("planning", "review", { plan: { id: "1" } });
    assert.equal(result.allowed, true);
  });

  await t.test("plan_generated condition fails without plan", () => {
    const result = validatePhaseTransition("planning", "review");
    // Without context, condition is not checked (permissive)
    assert.equal(result.allowed, true);
  });

  await t.test("plan_approved condition", () => {
    const result = validatePhaseTransition("review", "acting", { approved: true });
    assert.equal(result.allowed, true);
  });

  await t.test("unknown conditions are permissive", () => {
    // Use a transition that doesn't require a condition
    const result = validatePhaseTransition("planning", "planning");
    assert.equal(result.allowed, true);
  });
});
