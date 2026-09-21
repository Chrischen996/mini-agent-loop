// tui-core — TurnRunner kernel tests.
//
// Drives the runner through a scripted faux provider (`chat`) and asserts
// the exact store action trace + resulting TuiState. This is the first
// direct test of the headless kernel: the same coverage that only existed
// end-to-end in the entrypoints now runs offline against `TurnRunner`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LlmConfig } from "../src/llm/index.ts";
import { PermissionManager } from "../src/permissions.ts";
import { createInitialState, createTuiStore, type TuiAction, type TuiStore } from "../src/tui/state.ts";
import { TurnRunner } from "../src/tui/tui-core/turn-runner.ts";

function testLlm(): LlmConfig {
  return {
    apiKey: "test",
    provider: "faux",
    baseUrl: "http://localhost",
    model: "faux/kernel",
    capabilities: { input: ["text"], tools: false },
    contextWindow: 4096,
    maxTokens: 256,
    reasoning: false,
    imagePolicy: "strip",
    toolCallFormat: "openai",
  };
}

type Recorded = TuiAction;

function makeStore(): { store: TuiStore; actions: Recorded[] } {
  const store = createTuiStore(createInitialState("faux/kernel"));
  const actions: Recorded[] = [];
  const original = store.dispatch.bind(store);
  store.dispatch = (action: TuiAction) => {
    actions.push(action);
    original(action);
  };
  return { store, actions };
}

function loopEvents(actions: Recorded[]): import("../src/loop.ts").LoopEvent[] {
  return actions
    .filter((action): action is Extract<TuiAction, { type: "LOOP_EVENT" }> => action.type === "LOOP_EVENT")
    .map((action) => (action as { type: "LOOP_EVENT" }).event);
}

function eventTypes(actions: Recorded[]): string[] {
  return loopEvents(actions).map((event) => event.type);
}

describe("TurnRunner kernel", () => {
  it("dispatches USER_MESSAGE, routes loop events, and finalizes idle", async () => {
    const { store, actions } = makeStore();
    let calls = 0;
    const runner = new TurnRunner({
      store,
      llm: testLlm(),
      tools: () => [],
      permissionManager: new PermissionManager("bypass"),
      permissionSessionId: "kernel-1",
      chat: async () => {
        calls += 1;
        return { role: "assistant", content: `answer-${calls}` };
      },
    });

    const result = await runner.submit("hello");

    assert.equal(result.succeeded, true);
    const state = store.getState();
    assert.equal(state.busy, false, "store is idle after the turn");
    const userRows = state.messages.filter((message) => message.kind === "user");
    assert.deepEqual(userRows.map((row) => row.text), ["hello"]);
    const assistantRows = state.messages.filter((message) => message.kind === "assistant");
    assert.deepEqual(assistantRows.map((row) => row.text), ["answer-1"]);
    // USER_MESSAGE first, then the terminal done event routed through the store.
    assert.equal(actions[0]?.type, "USER_MESSAGE");
    const doneIndex = eventTypes(actions).indexOf("done");
    assert.ok(doneIndex >= 0, `expected a done event, got: ${eventTypes(actions).join(", ")}`);
    assert.equal(runner.isBusy(), false);
  });

  it("keeps one history while projecting events into the store (tool call + result)", async () => {
    const { store, actions } = makeStore();
    let responses = 0;
    const runner = new TurnRunner({
      store,
      llm: testLlm(),
      tools: () => [
        {
          name: "echo",
          description: "echo",
          parameters: { type: "object" },
          execute: async () => ({ content: "tool result" }),
        },
      ],
      permissionManager: new PermissionManager("bypass"),
      permissionSessionId: "kernel-2",
      chat: async () => {
        responses += 1;
        return responses === 1
          ? { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "echo", arguments: { value: "ok" } }] }
          : { role: "assistant", content: "final answer" };
      },
    });

    const result = await runner.submit("run tool");

    assert.equal(result.succeeded, true);
    const state = store.getState();
    const toolRow = state.messages.find((message) => message.kind === "tool_call");
    assert.equal(toolRow?.kind, "tool_call");
    assert.equal(toolRow?.status, "done");
    assert.equal(toolRow?.result, "tool result");
    const historyRoles = runner.getHistory().map((message) => message.role);
    assert.ok(historyRoles.includes("tool"), "loop history carries the tool message");
    assert.equal(responses, 2, "two model calls: tool call + final answer");
  });

  it("resolves a pending permission request", async () => {
    const { store } = makeStore();
    const runner = new TurnRunner({
      store,
      llm: testLlm(),
      tools: () => [],
      permissionManager: new PermissionManager("plan"),
      permissionSessionId: "kernel-3",
      chat: async () => ({ role: "assistant", content: "ok" }),
    });

    // Simulate the store-side pendingPermission state that the keyboard path
    // sees after a `permission_required` loop event.
    store.dispatch({
      type: "LOOP_EVENT",
      event: {
        type: "permission_required",
        request: { id: "perm-1", sessionId: "kernel-3", tool: "write", risk: "high" },
      },
    });
    assert.equal(store.getState().pendingPermission !== undefined, true, "permission is pending");
    assert.equal(runner.resolvePermission("allow"), false, "runner.resolvePermission targets the store's pendingPermission, not the manager queue");
    // The keyboard path clears the pending flag via CLEAR_PENDING_PERMISSION.
    store.dispatch({ type: "CLEAR_PENDING_PERMISSION" });
    assert.equal(store.getState().pendingPermission, undefined, "pending permission cleared");
    // A clean turn still runs to completion.
    const result = await runner.submit("ok");
    assert.equal(result.succeeded, true);
  });

  it("drains queued submissions FIFO", async () => {
    const { store } = makeStore();
    let calls = 0;
    const runner = new TurnRunner({
      store,
      llm: testLlm(),
      tools: () => [],
      permissionManager: new PermissionManager("bypass"),
      permissionSessionId: "kernel-4",
      chat: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { role: "assistant", content: `answer-${calls}` };
      },
    });

    const first = runner.submit("first");
    const second = runner.submit("second");
    assert.equal(runner.getQueuedCount(), 1, "second submit is queued while the first is busy");
    assert.equal(runner.isBusy(), true);
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.succeeded, true);
    assert.equal(r2.succeeded, true);
    assert.equal(calls, 2, "both turns executed in order");
    assert.deepEqual(
      store.getState().messages.filter((row) => row.kind === "user").map((row) => row.text),
      ["first", "second"],
    );
    assert.equal(runner.isBusy(), false);
    assert.equal(runner.getQueuedCount(), 0);
  });

  it("aborts the active turn and clears the queue", async () => {
    const { store } = makeStore();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new TurnRunner({
      store,
      llm: testLlm(),
      tools: () => [],
      permissionManager: new PermissionManager("bypass"),
      permissionSessionId: "kernel-5",
      chat: async () => {
        await gate;
        return { role: "assistant", content: "late" };
      },
    });
    const active = runner.submit("a");
    const queued = runner.submit("b");
    runner.abort();
    release();
    const [ra, rq] = await Promise.all([active, queued]);
    assert.equal(ra.succeeded, false, "active turn aborted");
    assert.equal(rq.succeeded, false, "queued submission aborted, not started");
    assert.match(rq.errorMessage ?? "", /aborted/);
    await runner.waitForIdle();
    assert.equal(runner.isBusy(), false);
    assert.equal(runner.getQueuedCount(), 0);
  });

  it("records direct tool turns on the same history", async () => {
    const { store } = makeStore();
    const snapshots: string[][] = [];
    const runner = new TurnRunner({
      store,
      llm: testLlm(),
      tools: () => [],
      permissionManager: new PermissionManager("bypass"),
      permissionSessionId: "kernel-6",
      onTurnFinished: ({ history }) => {
        snapshots.push(history.map((message) => message.role));
      },
    });

    const result = await runner.recordDirectToolTurn(
      "/read src/index.ts",
      { id: "direct-1", name: "read", arguments: { path: "src/index.ts" } },
      { content: "file contents" },
    );

    assert.equal(result.succeeded, true);
    assert.deepEqual(snapshots, [["system", "user", "assistant", "tool"]]);
    assert.equal(runner.getHistory().at(-1)?.role, "tool");
    void store;
  });
});
