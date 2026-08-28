import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatMessagesFromAgentHistory, createInitialState, createTuiStore, tuiReducer } from "../src/tui/state.ts";

describe("TUI store adapter", () => {
  it("notifies standalone render subscribers without changing reducer semantics", () => {
    const store = createTuiStore(createInitialState("model"));
    let notifications = 0;
    const unsubscribe = store.subscribe(() => { notifications++; });
    store.dispatch({ type: "SET_STATUS", status: "working" });
    assert.equal(store.getState().status, "working");
    assert.equal(notifications, 1);
    unsubscribe();
    store.dispatch({ type: "SET_STATUS", status: "done" });
    assert.equal(notifications, 1);
  });

  it("does not notify for reducer no-op actions", () => {
    const store = createTuiStore(createInitialState("model"));
    let notifications = 0;
    store.subscribe(() => { notifications++; });
    store.dispatch({ type: "SCROLL_TO_BOTTOM" });
    assert.equal(notifications, 0);
  });

  it("projects persisted history and sidebar state during session restore", () => {
    const plan = {
      id: "plan-1",
      sessionId: "session-1",
      createdAt: 1,
      summary: "Inspect workspace",
      steps: [],
      risks: [],
      requiredTools: [],
      status: "pending_review" as const,
    };
    const history = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "inspect" },
      { role: "assistant" as const, content: "", toolCalls: [{ id: "call-1", name: "read", arguments: { path: "a.ts" } }] },
      { role: "tool" as const, toolCallId: "call-1", name: "read", content: "file contents" },
      { role: "assistant" as const, content: "done" },
    ];
    let state = createInitialState("old-model");
    state = tuiReducer(state, {
      type: "RESTORE_SESSION",
      history,
      permissionMode: "approval",
      modelName: "new-model",
      phase: "review",
      currentPlan: plan,
      todos: [{ id: "todo-1", content: "Inspect", activeForm: "Inspecting", status: "in_progress", source: "model" }],
      todoRevision: 9,
    });
    assert.equal(state.modelName, "new-model");
    assert.equal(state.permissionMode, "approval");
    assert.equal(state.phase, "review");
    assert.equal(state.currentPlan?.id, "plan-1");
    assert.equal(state.messages.filter((message) => message.kind === "user").length, 1);
    const assistant = state.messages.find((message) => message.kind === "assistant");
    assert.equal(assistant?.kind, "assistant");
    assert.equal(assistant?.text, "done");
    const tool = state.messages.find((message) => message.kind === "tool_call");
    assert.equal(tool?.kind, "tool_call");
    assert.equal(tool?.status, "done");
    assert.equal(tool?.result, "file contents");
    assert.equal(state.todoItems?.[0]?.activeForm, "Inspecting");
  });

  it("does not leak system prompts in the restored chat projection", () => {
    const messages = chatMessagesFromAgentHistory([
      { role: "system", content: "secret instructions" },
      { role: "user", content: "hello" },
    ]);
    assert.deepEqual(messages, [{ kind: "user", text: "hello" }]);
  });
});
