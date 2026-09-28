import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createInitialState,
  preserveScrollOnAppend,
  tuiReducer,
} from "../src/tui/state.ts";
import { createPlanDocument } from "../src/plan/document.ts";
import { nextTodoRevision, type TodoItem } from "../src/todo.ts";

describe("TUI sidebar state", () => {
  it("stores the file-backed plan used by the Todo panel", () => {
    const plan = createPlanDocument({
      prompt: "task",
      rawMarkdown: "1. Read src/a.ts\n2. Write src/a.ts",
      cwd: "/tmp",
    });
    let state = createInitialState("test-model");

    state = tuiReducer(state, { type: "SET_TODO_PLAN", plan });
    assert.equal(state.todoPlan?.id, plan.id);

    state = tuiReducer(state, { type: "RESET" });
    assert.equal(state.todoPlan?.id, plan.id);

    state = tuiReducer(state, { type: "SET_TODO_PLAN", plan: undefined });
    assert.equal(state.todoPlan, undefined);
  });

  it("stores TodoWrite updates and ignores older revisions", () => {
    const todos: TodoItem[] = [{
      id: "todo-1",
      content: "Implement task",
      activeForm: "Implementing task",
      status: "in_progress",
      source: "model",
    }];
    let state = createInitialState("test-model");
    const firstRevision = nextTodoRevision();
    state = tuiReducer(state, { type: "SET_TODO_ITEMS", todos, revision: firstRevision });
    assert.equal(state.todoItems?.[0]?.status, "in_progress");

    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "todo_updated", todos: [{ ...todos[0]!, status: "completed" }], revision: firstRevision - 1 },
    });
    assert.equal(state.todoItems?.[0]?.status, "in_progress");

    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "todo_updated", todos: [{ ...todos[0]!, status: "completed" }], revision: nextTodoRevision() },
    });
    assert.equal(state.todoItems?.[0]?.status, "completed");
  });

  it("accepts the first TodoWrite update after a plan revision", () => {
    const plan = createPlanDocument({
      prompt: "task",
      rawMarkdown: "1. Read src/a.ts",
      cwd: "/tmp",
    });
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "SET_TODO_PLAN", plan });
    const todos: TodoItem[] = [{
      id: "todo-1",
      content: "Read files",
      activeForm: "Reading files",
      status: "in_progress",
      source: "model",
    }];

    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "todo_updated", todos, revision: nextTodoRevision() },
    });

    assert.equal(state.todoItems?.[0]?.content, "Read files");
  });

  it("tracks, deduplicates, sends, and clears image attachments", () => {
    const image = { path: "/tmp/screenshot.png", mimeType: "image/png", size: 42 };
    let state = createInitialState("test-model");

    state = tuiReducer(state, { type: "ADD_PENDING_IMAGE", image });
    state = tuiReducer(state, { type: "ADD_PENDING_IMAGE", image });
    assert.deepEqual(state.pendingImages, [image]);
    assert.match(state.status, /screenshot\.png/);

    state = tuiReducer(state, { type: "USER_MESSAGE", text: "Analyze this", images: [image] });
    assert.deepEqual(state.messages[0], { kind: "user", text: "Analyze this", images: [image] });

    state = tuiReducer(state, { type: "CLEAR_PENDING_IMAGES" });
    assert.deepEqual(state.pendingImages, []);
  });

  it("surfaces attachment errors without marking a running turn as finished", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "Keep working" });
    state = tuiReducer(state, { type: "ATTACHMENT_ERROR", message: "Clipboard has no image" });

    assert.equal(state.busy, true);
    assert.equal(state.status, "Unable to attach image");
    assert.deepEqual(state.messages.at(-1), { kind: "error", text: "Clipboard has no image" });
  });

  it("applies a coalesced assistant_deltas event in a single update", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "Hello" });

    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "assistant_deltas", reasoning: "think1", answer: "say1" },
    });
    assert.equal(state.streamingReasoning, "think1");
    assert.equal(state.streamingText, "say1");

    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "assistant_deltas", answer: "say2" },
    });
    assert.equal(state.streamingReasoning, "think1");
    assert.equal(state.streamingText, "say1say2");
    assert.equal(typeof state.lastStreamAt, "number");
    assert.equal(state.status, "Responding…");
  });

  it("tracks the completed task root and accumulates assistant usage", () => {
    let state = createInitialState("model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "Review the workspace" });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: {
        type: "assistant",
        message: { role: "assistant", content: "part one" },
        usage: { promptTokens: 100, inputTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
    });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: {
        type: "assistant",
        message: { role: "assistant", content: "part two" },
        usage: { promptTokens: 200, inputTokens: 200, completionTokens: 50, totalTokens: 250 },
      },
    });
    state = tuiReducer(state, { type: "LOOP_EVENT", event: { type: "done", messages: [] } });

    assert.equal(state.taskTitle, "Review the workspace");
    assert.equal(state.taskStatus, "completed");
    assert.equal(state.taskTokens, 400);
    assert.ok((state.taskDurationMs ?? -1) >= 0);
  });

  it("does not turn a cancelled task back into completed on a late done event", () => {
    let state = createInitialState("model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "Stop this task" });
    state = tuiReducer(state, { type: "CANCEL_GENERATION" });
    state = tuiReducer(state, { type: "LOOP_EVENT", event: { type: "done", messages: [] } });

    assert.equal(state.taskStatus, "cancelled");
  });

  it("keeps a bounded streaming preview while preserving the full assistant text", () => {
    let state = createInitialState("test-model");
    const first = "a".repeat(12_000);
    const second = "b".repeat(12_000);
    state = tuiReducer(state, { type: "LOOP_EVENT", event: { type: "assistant_delta", kind: "answer", text: first } });
    state = tuiReducer(state, { type: "LOOP_EVENT", event: { type: "assistant_delta", kind: "answer", text: second } });
    assert.ok(state.streamingText.length <= 16_000);
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "assistant", message: { role: "assistant", content: "" } },
    });
    const assistant = state.messages.at(-1);
    assert.equal(assistant?.kind, "assistant");
    if (assistant?.kind === "assistant") assert.equal(assistant.text, first + second);
    assert.deepEqual(state.streamingTextParts, []);
  });

  it("records context compaction events for the context notice", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "context_compacted", beforeTokens: 12_000, afterTokens: 4_000, reason: "token budget" },
    });
    assert.equal(state.contextTokens, 4_000);
    assert.deepEqual(state.contextCompactions, [{ before: 12_000, after: 4_000, reason: "token budget", turn: 1 }]);
  });

  it("ignores high-frequency subagent answer deltas in the transcript", () => {
    const state = createInitialState("test-model");
    const card = {
      kind: "subagent_call" as const,
      id: "sub-1",
      task: "inspect",
      depth: 0,
      status: "running" as const,
      innerEvents: [],
      toolCallCount: 0,
      startedAt: 0,
      expanded: false,
    };
    state.messages = [card];
    state.subagentIndexById = { "sub-1": 0 };
    const next = tuiReducer(state, {
      type: "SUBAGENT_EVENT",
      event: {
        type: "subagent_event",
        id: "sub-1",
        depth: 0,
        inner: { type: "assistant_delta", kind: "answer", text: "token" },
      },
    });
    assert.equal(next, state);
    assert.equal(next.messages[0], card);
  });

  it("bounds retained subagent progress events and uses the lifecycle index", () => {
    let state = createInitialState("test-model");
    const card = {
      kind: "subagent_call" as const,
      id: "sub-1",
      task: "inspect",
      depth: 0,
      status: "running" as const,
      innerEvents: [],
      toolCallCount: 0,
      startedAt: 0,
      expanded: false,
    };
    state.messages = Array.from({ length: 500 }, (_, index) => ({ kind: "notice" as const, text: `history-${index}` }));
    state.messages.push(card);
    state.subagentIndexById = { "sub-1": state.messages.length - 1 };
    const messagesReference = state.messages;
    for (let index = 0; index < 150; index++) {
      state = tuiReducer(state, {
        type: "SUBAGENT_EVENT",
        event: {
          type: "subagent_event",
          id: "sub-1",
          depth: 0,
          inner: { type: "tool_start", call: { id: `tool-${index}`, name: "read", arguments: { path: "x" } } },
        },
      });
    }
    assert.equal(state.messages, messagesReference, "subagent lifecycle updates must not copy the transcript array");
    const updated = state.messages.at(-1);
    assert.equal(updated?.kind, "subagent_call");
    if (updated?.kind === "subagent_call") {
      assert.equal(updated.innerEvents.length, 100);
      assert.equal(updated.innerEvents[0]?.label, "▶ read");
    }
  });

  it("tracks the goal, workflow step, file path, and tool card", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "Inspect the workspace" });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: {
        type: "tool_start",
        call: { id: "call-1", name: "read", arguments: { path: "src/index.ts" } },
      },
    });

    assert.equal(state.goal, "Inspect the workspace");
    assert.deepEqual(state.touchedFiles, ["src/index.ts"]);
    assert.equal(state.steps[0]?.status, "running");
    assert.equal(state.toolCards[0]?.status, "running");

    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: {
        type: "tool_end",
        call: { id: "call-1", name: "read", arguments: { path: "src/index.ts" } },
        result: { content: "export const answer = 42;", isError: false },
      },
    });

    assert.equal(state.steps[0]?.status, "done");
    assert.equal(state.toolCards[0]?.status, "done");
    assert.equal(state.toolCards[0]?.preview, "export const answer = 42;");
    assert.ok((state.toolCards[0]?.durationMs ?? -1) >= 0);
  });

  it("tracks active tool lookups without copying the transcript on tool_end", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "Inspect the workspace" });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: {
        type: "tool_start",
        call: { id: "call-1", name: "read", arguments: { path: "src/index.ts" } },
      },
    });
    assert.equal(state.activeToolId, "call-1");
    const messagesReference = state.messages;

    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: {
        type: "tool_end",
        call: { id: "call-1", name: "read", arguments: { path: "src/index.ts" } },
        result: { content: "export const answer = 42;", isError: false },
      },
    });

    assert.equal(state.activeToolId, undefined, "finished tool must clear the active pointer");
    assert.equal(state.messages, messagesReference, "tool completion must not copy the transcript array");
    const tool = state.messages.at(-1);
    assert.equal(tool?.kind, "tool_call");
    if (tool?.kind === "tool_call") {
      assert.equal(tool.status, "done");
      assert.equal(tool.result, "export const answer = 42;");
    }
  });

  it("clears sidebar state when the conversation is reset", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "Do work" });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "tool_start", call: { id: "call-1", name: "bash", arguments: { command: "pwd" } } },
    });
    state = tuiReducer(state, { type: "RESET" });
    assert.equal(state.goal, "");
    assert.deepEqual(state.steps, []);
    assert.deepEqual(state.touchedFiles, []);
    assert.deepEqual(state.toolCards, []);
  });

  it("cycles permission mode with TOGGLE_PERMISSION_MODE", () => {
    let state = createInitialState("test-model");
    // Default is plan; order is plan -> bypass
    assert.equal(state.permissionMode, "plan");

    // plan -> bypass
    state = tuiReducer(state, { type: "TOGGLE_PERMISSION_MODE" });
    assert.equal(state.permissionMode, "bypass");
    assert.equal(state.status, "Permission mode: Bypass permissions");

    // bypass -> plan
    state = tuiReducer(state, { type: "TOGGLE_PERMISSION_MODE" });
    assert.equal(state.permissionMode, "plan");
    assert.equal(state.status, "Permission mode: Plan mode");
  });

  it("preserves permission mode on RESET", () => {
    let state = createInitialState("test-model");
    // plan -> bypass
    state = tuiReducer(state, { type: "TOGGLE_PERMISSION_MODE" });
    assert.equal(state.permissionMode, "bypass");

    state = tuiReducer(state, { type: "RESET" });
    // Reset preserves permission mode
    assert.equal(state.permissionMode, "bypass");
  });

  it("tracks and clears pending permission requests", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: {
        type: "permission_required",
        request: {
          id: "perm-1",
          sessionId: "tui_session",
          tool: "write",
          arguments: { path: "src/app.tsx" },
          risk: "high",
        },
      },
    });

    assert.deepEqual(state.pendingPermission, {
      requestId: "perm-1",
      sessionId: "tui_session",
      tool: "write",
      arguments: { path: "src/app.tsx" },
      risk: "high",
    });
    assert.match(state.status, /Waiting for permission: write \(high\).*A allow.*D deny/);

    state = tuiReducer(state, { type: "CLEAR_PENDING_PERMISSION" });
    assert.equal(state.pendingPermission, undefined);
    assert.equal(state.status, "Running write…");
  });

  it("resets busy state when an error occurs", () => {
    let state = createInitialState("test-model");
    // Start a turn (sets busy to true)
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "Do work" });
    assert.equal(state.busy, true);

    // Simulate an error event
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "error", message: "API key missing" },
    });

    // After error, busy should be reset to false so input is enabled again
    assert.equal(state.busy, false);
    assert.equal(state.status, "Request failed");
    assert.equal(state.messages[state.messages.length - 1]?.kind, "error");
  });

  it("keeps the turn busy across an automatic max-turn continuation", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "Continue the task" });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "max_turns", maxTurns: 30, messages: [] },
    });

    assert.equal(state.busy, true);
    assert.match(state.status, /Turn limit reached \(30\), continuing…/);

    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "assistant_delta", kind: "reasoning", text: "next run" },
    });
    assert.equal(state.busy, true);
    assert.equal(state.streamingReasoning, "next run");
  });

  it("clears streamed output at a reasoning-only retry boundary", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "Answer this" });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "assistant_delta", kind: "reasoning", text: "stale reasoning" },
    });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "attempt_reset", reason: "reasoning_only", attempt: 1 },
    });

    assert.equal(state.streamingText, "");
    assert.equal(state.streamingReasoning, "");
    assert.equal(state.status, "Incomplete reasoning, retrying (1)…");
    assert.equal(state.busy, true);
  });

  it("clears transient output and shows timeout retry status", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "Answer this" });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "assistant_delta", kind: "answer", text: "stale" },
    });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: {
        type: "retry_attempt",
        errorType: "timeout",
        attempt: 1,
        maxRetries: 1,
        delayMs: 0,
        errorMessage: "LLM request timed out",
      },
    });

    assert.equal(state.streamingText, "");
    assert.equal(state.streamingReasoning, "");
    assert.equal(state.status, "Request timed out, retrying (1/1)…");
    assert.equal(state.busy, true);
  });

  it("reports automatic continuation without resetting context token usage", () => {
    let state = { ...createInitialState("test-model"), usedTokens: 42_000, contextTokens: 40_000, busy: true };
    state = tuiReducer(state, { type: "AUTO_CONTINUE", count: 1, max: 5 });

    assert.equal(state.busy, true);
    assert.equal(state.usedTokens, 42_000);
    assert.equal(state.contextTokens, 40_000);
    assert.equal(state.status, "Continuing… (1/5)");
  });

  it("scrolls history and re-pins on new user messages", () => {
    let state = createInitialState("test-model");
    for (let i = 0; i < 5; i++) {
      state = tuiReducer(state, { type: "USER_MESSAGE", text: `turn ${i}` });
      state = tuiReducer(state, {
        type: "LOOP_EVENT",
        event: { type: "done", messages: [] },
      });
    }
    assert.equal(state.scrollOffset, 0);

    state = tuiReducer(state, { type: "SCROLL_BY", delta: 2 });
    assert.equal(state.scrollOffset, 2);

    state = tuiReducer(state, { type: "SCROLL_BY", delta: 100 });
    assert.equal(state.scrollOffset, 102);

    state = tuiReducer(state, { type: "SCROLL_TO_BOTTOM" });
    assert.equal(state.scrollOffset, 0);

    state = tuiReducer(state, { type: "SCROLL_TO", offset: 3 });
    assert.equal(state.scrollOffset, 3);

    // New user turns always re-pin to the latest content.
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "fresh" });
    assert.equal(state.scrollOffset, 0);
  });

  it("resets scroll offset on RESET", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "a" });
    state = tuiReducer(state, { type: "LOOP_EVENT", event: { type: "done", messages: [] } });
    state = tuiReducer(state, { type: "SCROLL_BY", delta: 1 });
    assert.equal(state.scrollOffset, 1);
    state = tuiReducer(state, { type: "RESET" });
    assert.equal(state.scrollOffset, 0);
  });

  it("preserveScrollOnAppend keeps history stable while scrolled up", () => {
    assert.equal(preserveScrollOnAppend(0, 2), 0); // pinned to bottom
    assert.equal(preserveScrollOnAppend(2, 2), 4); // 2 + 2 added rows
    assert.equal(preserveScrollOnAppend(2, 0), 2); // no new rows
    assert.equal(preserveScrollOnAppend(5, 0), 5); // no new rows
  });

  it("preserves upward scroll when assistant and tool messages append", () => {
    let state = createInitialState("test-model");
    for (let i = 0; i < 3; i++) {
      state = tuiReducer(state, { type: "USER_MESSAGE", text: `turn ${i}` });
      state = tuiReducer(state, {
        type: "LOOP_EVENT",
        event: { type: "done", messages: [] },
      });
    }
    // 3 user messages so far
    assert.equal(state.messages.length, 3);

    state = tuiReducer(state, { type: "SCROLL_BY", delta: 2 });
    assert.equal(state.scrollOffset, 2);

    // Assistant finalizes a new message ("reply" = 1 margin + 1 text line = 2 rows).
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: {
        type: "assistant",
        message: { role: "assistant", content: "reply" },
      },
    });
    assert.equal(state.messages.length, 4);
    assert.equal(state.scrollOffset, 4); // 2 + 2 rows (margin + text)

    // Tool cards also append into history and must preserve viewport.
    // tool_call has no text field so estimateNewMessageRows gives 1+1=2.
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: {
        type: "tool_start",
        call: { id: "c1", name: "bash", arguments: { command: "ls" } },
      },
    });
    assert.equal(state.messages.length, 5);
    assert.equal(state.scrollOffset, 6); // 4 + 2 rows

    // Errors append too ("boom" = 1 margin + 1 text line = 2 rows).
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "error", message: "boom" },
    });
    assert.equal(state.messages.length, 6);
    assert.equal(state.scrollOffset, 8); // 6 + 2 rows
  });

  it("adds help and other notices as renderable messages", () => {
    const state = tuiReducer(createInitialState("test-model"), {
      type: "ADD_NOTICE",
      title: "Help",
      text: "/help show help",
    });
    assert.deepEqual(state.messages.at(-1), { kind: "notice", title: "Help", text: "/help show help" });
  });
});
