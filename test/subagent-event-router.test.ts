import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SubagentEventRouter, type SubagentEventRouterDeps } from "../src/tui/subagent-event-router.ts";
import type { LoopEvent } from "../src/loop.ts";
import type { SubagentEvent, SubagentRuntimeInfo } from "../src/subagent/types.ts";
import { createInitialState, type TuiAction, type TuiState } from "../src/tui/state.ts";

type SubagentEnd = Extract<SubagentEvent, { type: "subagent_end" }>;

const runtime: SubagentRuntimeInfo = {
  model: "m",
  provider: "p",
  baseUrl: "http://localhost/v1",
  thinkingMode: "fixed",
  modelSwitchSucceeded: true,
};

/** A minimal inner loop event for the non-end dispatch paths. */
const innerDone: LoopEvent = { type: "done", messages: [] };

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

/** Properly typed initial state; tests only override the fields they read. */
function initialState(overrides: Partial<TuiState> = {}): TuiState {
  return { ...createInitialState("test-model"), ...overrides };
}

const idleState = initialState({ busy: false });
const busyState = initialState({ busy: true });

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
  // The component hands the router live getters, so the router must follow a
  // ref that is reassigned to a new array/map instead of writing into the old
  // one. Tests swap these to prove the read is live.
  const pendingSubagentPromptsRef = { current: pendingSubagentPrompts };
  const promptQueueRef = { current: promptQueue };
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
    pendingSubagentPrompts: () => pendingSubagentPromptsRef.current,
    promptQueue: () => promptQueueRef.current,
    setQueuedCount: (count) => { queuedCounts.push(count); },
    submitPrompt: async (text) => { submitted.push(text); },
  };

  const router = new SubagentEventRouter(deps);
  // Wait for the router's async claim/queue IIFE to settle. Each setImmediate
  // turn drains the whole microtask queue, and a few rounds tolerate the
  // router gaining further awaits (a fixed microtask count would silently
  // stop testing anything once the flow grows one more await).
  const flush = async () => {
    for (let round = 0; round < 3; round += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  return {
    router,
    actions,
    submitted,
    queuedCounts,
    pendingSubagentPrompts,
    promptQueue,
    pendingSubagentPromptsRef,
    promptQueueRef,
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
    h.router.handle({ type: "subagent_event", id: "sub_f1", inner: innerDone, depth: 1 });
    assert.equal(h.subagentEvents().length, 0, "foreign sub-agent stream is not dispatched locally");

    const h2 = makeHarness();
    h2.router.handle({ type: "subagent_event", id: "sub_local", inner: innerDone, depth: 1 });
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

  it("queues when only a pending mode request is blocking, with no busy turn", async () => {
    // The busy check is `busy || pendingPermission || pendingModeRequest`.
    // Nothing else covers the third term on its own: a mode card awaiting A/D
    // must also hold the completion prompt back.
    const h = makeHarness({
      state: initialState({ busy: false, pendingModeRequest: { mode: "bypass", reason: "model asked to switch" } }),
      claimResult: true,
    });
    h.router.handle({
      type: "subagent_backgrounded",
      id: "sub_mode1",
      task: "mode-gated work",
      depth: 1,
    } as SubagentEvent);
    h.router.handle(endEvent({ id: "sub_mode1" }));
    await h.flush();

    assert.equal(h.promptQueue.length, 1, "a pending mode request queues the prompt");
    assert.equal(h.submitted.length, 0);
    assert.equal(h.delivered.length, 0);
  });

  it("mentions the worktree only when a branch is also present", async () => {
    const withBranch = makeHarness({ claimResult: true });
    withBranch.router.handle({
      type: "subagent_backgrounded",
      id: "sub_wt1",
      task: "worktree work",
      depth: 1,
    } as SubagentEvent);
    withBranch.router.handle(endEvent({
      id: "sub_wt1",
      worktreePath: "/tmp/wt-a",
      worktreeBranch: "agent-1",
    }));
    await withBranch.flush();
    assert.match(withBranch.notices()[0]!.text, /Worktree: \/tmp\/wt-a\nBranch: agent-1/);
    assert.match(withBranch.submitted[0]!, /isolated git worktree \/tmp\/wt-a on branch agent-1/);

    // A path without a branch must not print a half-formed worktree line.
    const pathOnly = makeHarness({ claimResult: true });
    pathOnly.router.handle({
      type: "subagent_backgrounded",
      id: "sub_wt2",
      task: "worktree work",
      depth: 1,
    } as SubagentEvent);
    pathOnly.router.handle(endEvent({ id: "sub_wt2", worktreePath: "/tmp/wt-b" }));
    await pathOnly.flush();
    assert.doesNotMatch(pathOnly.notices()[0]!.text, /Worktree:/);
    assert.doesNotMatch(pathOnly.submitted[0]!, /isolated git worktree/);
  });

  it("writes into the queue the component's ref points at now, not the one it captured", async () => {
    const h = makeHarness({ state: busyState, claimResult: true });
    // Simulate a ref reassignment (e.g. a session switch replacing the queue):
    // the router must follow the live ref, not keep pushing into the old array.
    const replacement: string[] = [];
    h.promptQueueRef.current = replacement;

    h.router.handle({
      type: "subagent_backgrounded",
      id: "sub_live1",
      task: "live queue work",
      depth: 1,
    } as SubagentEvent);
    h.router.handle(endEvent({ id: "sub_live1" }));
    await h.flush();

    assert.equal(replacement.length, 1, "the current queue received the prompt");
    assert.match(replacement[0]!, /live queue work/);
    assert.equal(h.promptQueue.length, 0, "the stale queue captured at construction stays empty");
    assert.deepEqual(h.queuedCounts, [1]);
  });

  it("parks a foreign-session prompt in the map the ref points at now", async () => {
    const h = makeHarness({ claimResult: true });
    const replacement = new Map<string, string[]>();
    h.pendingSubagentPromptsRef.current = replacement;

    h.router.handle({
      type: "subagent_backgrounded",
      id: "sub_live2",
      task: "foreign live work",
      depth: 1,
      ownerSessionId: "other-session",
    } as SubagentEvent);
    h.router.handle(endEvent({ id: "sub_live2" }));
    await h.flush();

    assert.match(replacement.get("other-session")?.[0] ?? "", /foreign live work/);
    assert.equal(h.pendingSubagentPrompts.size, 0, "the stale map captured at construction stays empty");
  });
});
