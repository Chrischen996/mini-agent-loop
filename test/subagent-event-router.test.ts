import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SubagentEventRouter, type SubagentEventRouterDeps } from "../src/tui/subagent-event-router.ts";
import type { SubagentEvent } from "../src/subagent/types.ts";
import type { TuiAction, TuiState } from "../src/tui/state.ts";

type SubagentEnd = Extract<SubagentEvent, { type: "subagent_end" }>;

const runtime = { model: "m", provider: "p" } as never;

function endEvent(overrides: Partial<SubagentEnd> = {}): SubagentEvent {
  return {
    type: "subagent_end",
    id: "sub_r1",
    result: "done output",
    success: true,
    depth: 1,
    turns: 2,
    totalTokens: 10,
    runtime,
    autoDelegationInherited: false,
    ...overrides,
  };
}

const idleState = {
  busy: false,
  pendingPermission: undefined,
  pendingModeRequest: undefined,
  phase: "planning",
  currentPlan: undefined,
} as unknown as TuiState;

const busyState = {
  ...idleState,
  busy: true,
} as unknown as TuiState;

/** Harness with a controllable claimAutoWake promise so the async flow and
 *  its state-read timing can be asserted deterministically. */
function makeHarness(options: {
  state?: TuiState;
  claimResult?: boolean;
  claimThrows?: Error;
} = {}) {
  const actions: TuiAction[] = [];
  const submitted: string[] = [];
  const queuedCounts: number[] = [];
  const pendingSubagentPrompts = new Map<string, string[]>();
  const promptQueue: string[] = [];
  const delivered: Array<{ taskId: string; owner?: string }> = [];
  const stateReads: Array<"before-claim" | "after-claim"> = [];

  let claimResolved = false;
  let releaseClaim!: (value: boolean) => void;
  // A `claimResult` preset resolves the gate immediately; an explicit
  // `claimThrows` rejects; otherwise the test controls the gate manually.
  const claimGate = options.claimThrows
    ? Promise.reject(options.claimThrows)
    : options.claimResult !== undefined
      ? Promise.resolve(options.claimResult)
      : new Promise<boolean>((resolve) => { releaseClaim = resolve; });
  if (options.claimThrows) claimGate.catch(() => undefined);
  if (options.claimResult !== undefined) claimResolved = true;

  const deps: SubagentEventRouterDeps = {
    conversationId: () => "me",
    getState: () => {
      stateReads.push(claimResolved ? "after-claim" : "before-claim");
      return options.state ?? idleState;
    },
    dispatch: (action) => { actions.push(action); },
    registry: {
      claimAutoWake: async () => {
        const result = await claimGate;
        return options.claimResult ?? result;
      },
      markAutoWakeDelivered: async (taskId: string, owner?: string) => {
        delivered.push({ taskId, owner });
        return true;
      },
    },
    pendingSubagentPrompts,
    promptQueue,
    setQueuedCount: (count) => { queuedCounts.push(count); },
    submitPrompt: async (text) => { submitted.push(text); },
  };

  const router = new SubagentEventRouter(deps);
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  return {
    router,
    actions,
    submitted,
    queuedCounts,
    pendingSubagentPrompts,
    promptQueue,
    delivered,
    stateReads,
    releaseClaim: (value: boolean) => { claimResolved = true; releaseClaim(value); },
    flush,
    notices: () => actions.flatMap((a) => (a.type === "ADD_NOTICE" ? [{ title: a.title ?? "", text: a.text }] : [])),
    subagentEvents: () => actions.filter((a) => a.type === "SUBAGENT_EVENT"),
  };
}

describe("SubagentEventRouter", () => {
  it("records a backgrounded task and routes its completion to the owning other session", async () => {
    const h = makeHarness({ claimResult: true });
    h.router.handle({
      type: "subagent_backgrounded",
      id: "sub_x1",
      task: "explore the repo",
      depth: 1,
      ownerSessionId: "other-session",
    } as SubagentEvent);
    h.router.handle(endEvent({ id: "sub_x1" }));
    await h.flush();

    assert.equal(h.subagentEvents().length, 0, "no local card for a foreign-session sub-agent");
    const queued = h.pendingSubagentPrompts.get("other-session");
    assert.ok(queued, "prompt parked for the owning session");
    assert.match(queued![0]!, /explore the repo/);
    assert.equal(h.notices().length, 0, "no local notice");
    assert.equal(h.submitted.length, 0);
  });

  it("dispatches non-end events of the local session and skips foreign ones", async () => {
    const h = makeHarness();
    h.router.handle({
      type: "subagent_backgrounded",
      id: "sub_f1",
      task: "foreign",
      depth: 1,
      ownerSessionId: "elsewhere",
    } as SubagentEvent);
    h.router.handle({ type: "subagent_event", id: "sub_f1", inner: { type: "done", messages: [] } as never, depth: 1 } as SubagentEvent);
    assert.equal(h.subagentEvents().length, 0, "foreign sub-agent stream is not dispatched locally");

    const h2 = makeHarness();
    h2.router.handle({ type: "subagent_event", id: "sub_local", inner: { type: "done", messages: [] } as never, depth: 1 } as SubagentEvent);
    assert.equal(h2.subagentEvents().length, 1);
  });

  it("dispatches an end event with no tracked background task as a plain card", async () => {
    const h = makeHarness({ claimResult: true });
    h.router.handle(endEvent({ id: "sub_unknown" }));
    await h.flush();

    assert.equal(h.subagentEvents().length, 1);
    assert.equal(h.notices().length, 0, "no completion notice without a tracked task");
    assert.equal(h.submitted.length, 0);
    assert.equal(h.promptQueue.length, 0);
  });

  it("does nothing when the auto-wake claim is refused", async () => {
    const h = makeHarness({ claimResult: false });
    h.router.handle({
      type: "subagent_backgrounded",
      id: "sub_q1",
      task: "queued work",
      depth: 1,
    } as SubagentEvent);
    h.router.handle(endEvent({ id: "sub_q1" }));
    await h.flush();

    assert.equal(h.subagentEvents().length, 1, "local card still dispatched");
    assert.equal(h.promptQueue.length, 0);
    assert.equal(h.submitted.length, 0);
    assert.equal(h.delivered.length, 0);
    assert.equal(h.notices().length, 0);
  });

  it("queues the completion prompt when the local session is busy", async () => {
    const h = makeHarness({ state: busyState, claimResult: true });
    h.router.handle({
      type: "subagent_backgrounded",
      id: "sub_b1",
      task: "busy work",
      depth: 1,
    } as SubagentEvent);
    h.router.handle(endEvent({ id: "sub_b1" }));
    await h.flush();

    const notice = h.notices()[0]!;
    assert.equal(notice.title, "Background sub-agent completed");
    assert.match(notice.text, /busy work: completed/);
    assert.equal(h.promptQueue.length, 1);
    assert.deepEqual(h.queuedCounts, [1]);
    assert.equal(h.submitted.length, 0);
    assert.equal(h.delivered.length, 0);
  });

  it("delivers immediately when the local session is idle", async () => {
    const h = makeHarness({ claimResult: true });
    h.router.handle({
      type: "subagent_backgrounded",
      id: "sub_d1",
      task: "idle work",
      depth: 1,
    } as SubagentEvent);
    h.router.handle(endEvent({ id: "sub_d1" }));
    await h.flush();

    assert.equal(h.notices()[0]?.title, "Background sub-agent completed");
    assert.equal(h.submitted.length, 1);
    assert.match(h.submitted[0]!, /idle work/);
    assert.deepEqual(h.delivered, [{ taskId: "sub_d1", owner: "me" }]);
    assert.equal(h.promptQueue.length, 0);
  });

  it("reports a failure notice when the claim throws", async () => {
    const h = makeHarness({ claimThrows: new Error("registry offline") });
    h.router.handle({
      type: "subagent_backgrounded",
      id: "sub_e1",
      task: "boom work",
      depth: 1,
    } as SubagentEvent);
    h.router.handle(endEvent({ id: "sub_e1" }));
    await h.flush();

    assert.equal(h.notices()[0]?.title, "Sub-agent completion handling failed");
    assert.match(h.notices()[0]?.text ?? "", /registry offline/);
    assert.equal(h.submitted.length, 0);
  });

  it("reads the queue-vs-deliver state only after the claim resolves", async () => {
    // No preset claimResult: the gate stays pending until releaseClaim, so
    // every getState() call is attributable to a precise point in the flow.
    const h = makeHarness();
    h.router.handle({
      type: "subagent_backgrounded",
      id: "sub_t1",
      task: "timing check",
      depth: 1,
    } as SubagentEvent);
    h.router.handle(endEvent({ id: "sub_t1" }));

    // Synchronously, exactly one state read happened: the goalLoopActive
    // check that gates the claim itself (its argument evaluation).
    assert.deepEqual(h.stateReads, ["before-claim"]);
    assert.equal(h.promptQueue.length, 0, "nothing queued before the claim resolves");

    h.releaseClaim(true);
    await h.flush();

    assert.deepEqual(h.stateReads, ["before-claim", "after-claim"]);
    assert.equal(h.submitted.length, 1, "idle delivery executed after the claim");
  });
});
