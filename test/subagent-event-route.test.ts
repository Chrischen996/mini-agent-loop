import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  goalLoopActive,
  planSubagentCompletion,
  subagentCompletionStatus,
  type BackgroundSubagentRecord,
} from "../src/tui/subagent-event-route.ts";
import type { SubagentEvent } from "../src/subagent/types.ts";

type SubagentEnd = Extract<SubagentEvent, { type: "subagent_end" }>;
const runtime = { model: "m", provider: "p", thinkingLevel: undefined } as never;

function endEvent(overrides: Partial<SubagentEnd> = {}): SubagentEnd {
  return {
    type: "subagent_end",
    id: "sub_test",
    result: "the result",
    success: true,
    depth: 1,
    turns: 3,
    totalTokens: 100,
    runtime,
    autoDelegationInherited: false,
    ...overrides,
  };
}

const record: BackgroundSubagentRecord = { task: "build the thing", ownerSessionId: "owner-a" };

describe("subagent completion routing", () => {
  it("derives the human status wording", () => {
    assert.equal(subagentCompletionStatus(endEvent({})), "completed");
    assert.equal(subagentCompletionStatus(endEvent({ success: false, partial: true })), "completed with partial results");
    assert.equal(subagentCompletionStatus(endEvent({ success: false })), "failed");
  });

  it("routes a completion owned by another session into that session's queue", () => {
    const plan = planSubagentCompletion({
      event: endEvent(),
      background: record,
      ownerSessionId: "owner-a",
      belongsToOtherSession: true,
      state: { busy: false, phase: "planning", currentPlan: undefined },
    });
    assert.equal(plan.kind, "other-session");
    if (plan.kind !== "other-session") return;
    assert.equal(plan.ownerSessionId, "owner-a");
    assert.match(plan.prompt, /build the thing/);
    assert.match(plan.prompt, /Background sub-agent sub_test/);
  });

  it("queues the prompt when the local session is busy", () => {
    const plan = planSubagentCompletion({
      event: endEvent(),
      background: record,
      ownerSessionId: "owner-a",
      belongsToOtherSession: false,
      state: { busy: true, phase: "acting", currentPlan: undefined },
    });
    assert.equal(plan.kind, "queue");
    if (plan.kind !== "queue") return;
    assert.equal(plan.notice.title, "Background sub-agent completed");
    assert.match(plan.notice.text, /build the thing: completed/);
  });

  it("queues when a pending permission is in flight", () => {
    const plan = planSubagentCompletion({
      event: endEvent(),
      background: record,
      ownerSessionId: "owner-a",
      belongsToOtherSession: false,
      state: {
        busy: false,
        pendingPermission: { request: {} } as never,
        phase: "planning",
        currentPlan: undefined,
      },
    });
    assert.equal(plan.kind, "queue");
  });

  it("delivers immediately when the local session is idle", () => {
    const plan = planSubagentCompletion({
      event: endEvent(),
      background: record,
      ownerSessionId: "owner-a",
      belongsToOtherSession: false,
      state: { busy: false, phase: "planning", currentPlan: undefined },
    });
    assert.equal(plan.kind, "deliver");
    if (plan.kind !== "deliver") return;
    assert.equal(plan.notice.title, "Background sub-agent completed");
    assert.match(plan.prompt, /sub_test/);
  });

  it("surfaces worktree metadata in the notice when present", () => {
    const plan = planSubagentCompletion({
      event: endEvent({ worktreePath: "/wt", worktreeBranch: "feat/x" }),
      background: record,
      ownerSessionId: "owner-a",
      belongsToOtherSession: false,
      state: { busy: false, phase: "planning", currentPlan: undefined },
    });
    if (plan.kind === "other-session") throw new Error("expected local delivery");
    assert.match(plan.notice.text, /Worktree: \/wt/);
    assert.match(plan.notice.text, /Branch: feat\/x/);
  });

  it("detects a goal loop as active from phase or executing plan", () => {
    assert.equal(goalLoopActive({ phase: "acting", currentPlan: undefined } as never), true);
    assert.equal(goalLoopActive({ phase: "planning", currentPlan: { status: "executing" } as never } as never), true);
    assert.equal(goalLoopActive({ phase: "planning", currentPlan: undefined } as never), false);
    assert.equal(goalLoopActive({ phase: "planning", currentPlan: { status: "pending" } as never } as never), false);
  });
});
