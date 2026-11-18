import assert from "node:assert/strict";
import { test } from "node:test";
import { goalStatusSegmentElapsed } from "../src/goal/display.ts";
import type { GoalState } from "../src/goal/types.ts";

function goal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    sessionId: "session",
    goalId: "goal",
    objective: "Ship it",
    status: "active",
    tokensUsed: 12_000,
    timeUsedSeconds: 30,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

test("active goal status shows live elapsed time", () => {
  const current = goal({ createdAt: 1_000, timeUsedSeconds: 30 });
  assert.equal(goalStatusSegmentElapsed(current, 61_000, 59_000), "Goal 32s");
});

test("budgeted goal status combines live elapsed time with token usage", () => {
  const current = goal({ createdAt: 1_000, timeUsedSeconds: 0, tokenBudget: 50_000 });
  assert.equal(goalStatusSegmentElapsed(current, 61_000, 59_000), "Goal 2s 12K/50K");
});
