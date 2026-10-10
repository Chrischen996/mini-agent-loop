import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChatStreamState } from "../apps/web/src/lib/event-adapter.ts";
import type { PlanSummary } from "../apps/web/src/types/api.ts";

describe("web ui P4 features (plan & permissions & events)", () => {
  it("captures plan_updated events into currentPlan and emits note", () => {
    const state = new ChatStreamState();
    const fakePlan: PlanSummary = {
      id: "plan-1",
      status: "approved",
      prompt: "Add tests for P4",
      approvedBy: "user",
      steps: [
        { index: 0, text: "Write tests", status: "completed" },
        { index: 1, text: "Verify typecheck", status: "running" },
      ],
      changedFiles: ["test/web-ui-p4.test.ts"],
    };

    state.apply({
      type: "plan_updated",
      plan: fakePlan,
    });

    assert.equal(state.currentPlan?.id, "plan-1");
    assert.equal(state.currentPlan?.status, "approved");
    assert.equal(state.currentPlan?.steps?.length, 2);
    const note = state.items.find((item) => item.kind === "note");
    assert.ok(note);
    if (note && note.kind === "note") {
      assert.match(note.text, /Plan approved/);
    }
  });

  it("resets currentPlan when loadHistory is called", () => {
    const state = new ChatStreamState();
    state.currentPlan = { id: "p1", status: "draft", prompt: "task" };
    state.loadHistory([]);
    assert.equal(state.currentPlan, null);
    assert.deepEqual(state.items, []);
  });

  it("handles permission_required event with full fields", () => {
    const state = new ChatStreamState();
    state.apply({
      type: "permission_required",
      requestId: "req-123",
      tool: "bash",
      risk: "high",
    });

    const perm = state.items.find((item) => item.kind === "permission");
    assert.ok(perm);
    if (perm && perm.kind === "permission") {
      assert.equal(perm.requestId, "req-123");
      assert.equal(perm.tool, "bash");
      assert.equal(perm.risk, "high");
      assert.equal(perm.status, "pending");
    }
  });
});
