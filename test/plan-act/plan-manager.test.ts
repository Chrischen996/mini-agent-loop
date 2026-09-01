import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PlanManager } from "../../src/plan-act/plan-manager.ts";
import type { ExecutionPlan, ExecutionStep } from "../../src/plan-act/types.ts";

describe("PlanManager", () => {
  let manager: PlanManager;

  beforeEach(() => {
    manager = new PlanManager();
  });

  describe("createPlan", () => {
    test("creates a draft plan", () => {
      const steps: ExecutionStep[] = [
        {
          id: "step_1",
          order: 1,
          description: "Read file",
          tool: "read",
          arguments: { path: "test.txt" },
          risk: "safe",
          rationale: "Need to see current content",
          status: "pending",
        },
      ];

      const plan = manager.createPlan("session_1", "Test plan", steps);

      assert.ok(plan.id.startsWith("plan_"));
      assert.equal(plan.sessionId, "session_1");
      assert.equal(plan.summary, "Test plan");
      assert.equal(plan.steps.length, 1);
      assert.equal(plan.status, "draft");
      assert.deepStrictEqual(plan.requiredTools, ["read"]);
    });

    test("extracts required tools from steps", () => {
      const steps: ExecutionStep[] = [
        { id: "1", order: 1, description: "a", tool: "read", arguments: {}, risk: "safe", rationale: "", status: "pending" },
        { id: "2", order: 2, description: "b", tool: "write", arguments: {}, risk: "medium", rationale: "", status: "pending" },
        { id: "3", order: 3, description: "c", tool: "read", arguments: {}, risk: "safe", rationale: "", status: "pending" },
      ];

      const plan = manager.createPlan("s1", "Test", steps);
      assert.deepEqual(plan.requiredTools.sort(), ["read", "write"].sort());
    });
  });

  describe("getPlan", () => {
    test("returns undefined for non-existent plan", () => {
      assert.equal(manager.getPlan("nonexistent"), undefined);
    });

    test("returns created plan", () => {
      const plan = manager.createPlan("s1", "Test", []);
      const retrieved = manager.getPlan(plan.id);
      assert.equal(retrieved?.id, plan.id);
    });
  });

  describe("session ownership", () => {
    test("restores and clones plans without sharing state", () => {
      const parent = manager.createPlan("parent", "Test", [
        { id: "step-1", order: 1, description: "Read", tool: "read", arguments: { path: "a" }, risk: "safe", rationale: "inspect", status: "pending" },
      ]);
      const restored = manager.restorePlan({ ...structuredClone(parent), id: "restored", sessionId: "restored-session" });
      assert.equal(manager.getSessionPlans("restored-session")[0]?.id, restored.id);

      const child = manager.clonePlan(parent, "child");
      child.steps[0]!.arguments.path = "child-only";

      assert.notEqual(child.id, parent.id);
      assert.equal(child.sessionId, "child");
      assert.equal(parent.steps[0]!.arguments.path, "a");
      assert.equal(manager.getSessionPlans("child")[0]?.id, child.id);
    });
  });

  describe("getCurrentPlan", () => {
    test("returns most recent non-rejected plan", () => {
      const plan1 = manager.createPlan("s1", "Plan 1", []);
      const plan2 = manager.createPlan("s1", "Plan 2", []);
      
      manager.rejectPlan(plan1.id);
      
      const current = manager.getCurrentPlan("s1");
      assert.equal(current?.id, plan2.id);
    });

    test("skips rejected plans", () => {
      const plan = manager.createPlan("s1", "Test", []);
      manager.markPendingReview(plan.id);
      manager.rejectPlan(plan.id);
      
      assert.equal(manager.getCurrentPlan("s1"), undefined);
    });
  });

  describe("markPendingReview", () => {
    test("changes status to pending_review", () => {
      const plan = manager.createPlan("s1", "Test", []);
      const updated = manager.markPendingReview(plan.id);
      
      assert.equal(updated?.status, "pending_review");
    });

    test("returns null for non-existent plan", () => {
      assert.equal(manager.markPendingReview("nonexistent"), null);
    });
  });

  describe("approvePlan", () => {
    test("changes status to approved", () => {
      const plan = manager.createPlan("s1", "Test", []);
      manager.markPendingReview(plan.id);
      const approved = manager.approvePlan(plan.id);
      
      assert.equal(approved?.status, "approved");
      assert.ok(approved?.reviewedAt);
    });

    test("sets execution mode if provided", () => {
      const plan = manager.createPlan("s1", "Test", []);
      manager.markPendingReview(plan.id);
      const approved = manager.approvePlan(plan.id, { executionMode: "auto" });
      
      assert.equal(approved?.executionMode, "auto");
    });

    test("sets review notes if provided", () => {
      const plan = manager.createPlan("s1", "Test", []);
      manager.markPendingReview(plan.id);
      const approved = manager.approvePlan(plan.id, { notes: "Looks good" });
      
      assert.equal(approved?.reviewNotes, "Looks good");
    });
  });

  describe("rejectPlan", () => {
    test("changes status to rejected", () => {
      const plan = manager.createPlan("s1", "Test", []);
      manager.markPendingReview(plan.id);
      const rejected = manager.rejectPlan(plan.id, "Too risky");
      
      assert.equal(rejected?.status, "rejected");
      assert.ok(rejected?.reviewNotes?.includes("Too risky"));
    });
  });

  describe("updateSteps", () => {
    test("updates steps and required tools", () => {
      const plan = manager.createPlan("s1", "Test", []);
      
      const newSteps: ExecutionStep[] = [
        { id: "1", order: 1, description: "a", tool: "bash", arguments: {}, risk: "high", rationale: "", status: "pending" },
      ];
      
      const updated = manager.updateSteps(plan.id, newSteps);
      
      assert.equal(updated?.steps.length, 1);
      assert.deepEqual(updated?.requiredTools, ["bash"]);
    });

    test("resets status to modified if was approved", () => {
      const plan = manager.createPlan("s1", "Test", []);
      manager.markPendingReview(plan.id);
      manager.approvePlan(plan.id);
      
      manager.updateSteps(plan.id, []);
      
      const updated = manager.getPlan(plan.id);
      assert.equal(updated?.status, "modified");
    });
  });

  describe("updateStepStatus", () => {
    test("updates step status and result", () => {
      const plan = manager.createPlan("s1", "Test", [
        { id: "s1", order: 1, description: "a", tool: "read", arguments: {}, risk: "safe", rationale: "", status: "pending" },
      ]);
      
      const updated = manager.updateStepStatus(
        plan.id,
        "s1",
        "completed",
        { content: "ok" }
      );
      
      const step = updated?.steps.find((s) => s.id === "s1");
      assert.equal(step?.status, "completed");
      assert.deepEqual(step?.result, { content: "ok" });
    });

    test("updates completion counters", () => {
      const plan = manager.createPlan("s1", "Test", [
        { id: "1", order: 1, description: "a", tool: "read", arguments: {}, risk: "safe", rationale: "", status: "pending" },
        { id: "2", order: 2, description: "b", tool: "write", arguments: {}, risk: "medium", rationale: "", status: "pending" },
      ]);
      
      manager.updateStepStatus(plan.id, "1", "completed");
      
      const updated = manager.getPlan(plan.id);
      assert.equal(updated?.completedSteps, 1);
      assert.equal(updated?.failedSteps, 0);
    });
  });

  describe("deletePlan", () => {
    test("removes plan and updates session list", () => {
      const plan = manager.createPlan("s1", "Test", []);
      
      const deleted = manager.deletePlan(plan.id);
      assert.equal(deleted, true);
      assert.equal(manager.getPlan(plan.id), undefined);
      assert.equal(manager.getPlanCount("s1"), 0);
    });
  });

  describe("serialize/deserialize", () => {
    test("round-trip serialization", () => {
      const plan = manager.createPlan("s1", "Test", []);
      manager.markPendingReview(plan.id);
      
      const json = manager.serialize(plan);
      const restored = manager.deserialize(json);
      
      assert.equal(restored?.id, plan.id);
      assert.equal(restored?.sessionId, plan.sessionId);
      assert.equal(restored?.summary, plan.summary);
    });

    test("deserialize handles missing optional fields", () => {
      const json = JSON.stringify({
        id: "p1",
        sessionId: "s1",
        summary: "Test",
        steps: [],
        status: "draft",
      });
      
      const restored = manager.deserialize(json);
      assert.ok(restored);
      assert.equal(restored?.version, 1); // default
    });
  });
});
