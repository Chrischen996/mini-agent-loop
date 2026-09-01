import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getTodoPanelRows, planToTodoItems, todoProgressMeter } from "../src/tui/todo-format.ts";
import { TodoPanel } from "../src/tui/components/TodoPanel.tsx";
import { createInitialState, tuiReducer } from "../src/tui/state.ts";
import { getMessageFeedHeight, getPickerLayout } from "../src/tui/layout.ts";
import type { TodoItem } from "../src/todo.ts";
import { confirmTodoEditor, createTodoEditorState, reduceTodoEditor } from "../src/tui/todo-editor.ts";

describe("TUI todo state", () => {
  const editableTodos: TodoItem[] = [
    { id: "a", content: "First", activeForm: "First", status: "pending", source: "model" },
    { id: "b", content: "Running", activeForm: "Running", status: "in_progress", source: "model" },
  ];

  it("cycles status exclusively and clamps selection after delete", () => {
    let editor = createTodoEditorState(editableTodos);
    editor = reduceTodoEditor(editor, { type: "MOVE", delta: 1 });
    editor = reduceTodoEditor(editor, { type: "CYCLE_STATUS" });
    assert.deepEqual(editor.todos.map((todo) => todo.status), ["pending", "completed"]);
    editor = reduceTodoEditor(editor, { type: "CYCLE_STATUS" });
    assert.deepEqual(editor.todos.map((todo) => todo.status), ["pending", "pending"]);
    editor = reduceTodoEditor(editor, { type: "CYCLE_STATUS" });
    assert.deepEqual(editor.todos.map((todo) => todo.status), ["pending", "in_progress"]);
    editor = reduceTodoEditor(editor, { type: "DELETE" });
    assert.equal(editor.selectedIndex, 0);
    assert.deepEqual(editor.todos, [editableTodos[0]]);
  });

  it("confirms add and edit drafts and cancels without changing the snapshot", () => {
    let editor = createTodoEditorState(editableTodos);
    editor = reduceTodoEditor(editor, { type: "BEGIN_ADD" });
    editor = reduceTodoEditor(editor, { type: "INPUT", value: "New item" });
    editor = reduceTodoEditor(editor, { type: "CONFIRM" });
    assert.equal(editor.mode, "select");
    assert.equal(editor.todos.at(-1)?.content, "New item");

    editor = reduceTodoEditor(editor, { type: "MOVE", delta: -2 });
    editor = reduceTodoEditor(editor, { type: "BEGIN_EDIT" });
    editor = reduceTodoEditor(editor, { type: "INPUT", value: "Changed" });
    editor = reduceTodoEditor(editor, { type: "CONFIRM" });
    assert.equal(editor.todos[0]?.content, "Changed");

    const beforeCancel = editor.todos;
    editor = reduceTodoEditor(editor, { type: "BEGIN_EDIT" });
    editor = reduceTodoEditor(editor, { type: "INPUT", value: "Discarded" });
    editor = reduceTodoEditor(editor, { type: "CANCEL" });
    assert.deepEqual(editor.todos, beforeCancel);
    assert.equal(editor.mode, "select");
  });

  it("keeps the old snapshot when a draft confirmation is invalid", () => {
    let editor = reduceTodoEditor(createTodoEditorState(editableTodos), { type: "BEGIN_ADD" });
    editor = reduceTodoEditor(editor, { type: "INPUT", value: "   " });
    const failed = reduceTodoEditor(editor, { type: "CONFIRM" });
    assert.deepEqual(failed.todos, editableTodos);
    assert.equal(failed.mode, "add");
    assert.match(failed.error ?? "", /non-empty/i);
  });

  it("confirms the current editor snapshot for select-mode Enter", () => {
    let editor = createTodoEditorState(editableTodos);
    editor = reduceTodoEditor(editor, { type: "DELETE" });
    const confirmed = confirmTodoEditor(editor);
    assert.deepEqual(confirmed.todos, [editableTodos[1]]);
    assert.equal(confirmed, editor);
  });

  it("replaces the independent todo snapshot with a revision guard", () => {
    const todos: TodoItem[] = [{ id: "a", content: "Run tests", activeForm: "Running tests", status: "in_progress", source: "model" as const }];
    const next = tuiReducer(createInitialState("model"), {
      type: "SET_TODO_ITEMS",
      todos,
      revision: 1,
    });

    assert.deepEqual(next.todoItems, todos);
  });

  it("ignores stale todo snapshots", () => {
    const state = tuiReducer(createInitialState("model"), {
      type: "SET_TODO_ITEMS",
      todos: [{ id: "a", content: "First", activeForm: "First", status: "pending", source: "model" as const }],
      revision: 5,
    });
    const stale = tuiReducer(state, {
      type: "SET_TODO_ITEMS",
      todos: [{ id: "b", content: "Stale", activeForm: "Stale", status: "completed", source: "model" as const }],
      revision: 2,
    });

    assert.equal(stale.todoItems?.[0].id, "a");
  });

  it("clears todos on reset while preserving global display settings", () => {
    const state = tuiReducer(createInitialState("model"), {
      type: "SET_TODO_ITEMS",
      todos: [{ id: "a", content: "Done", activeForm: "Done", status: "completed", source: "model" as const }],
      revision: 1,
    });
    const next = tuiReducer(state, { type: "RESET" });

    assert.deepEqual(next.todoItems, undefined);
    assert.equal(next.permissionMode, state.permissionMode);
    assert.equal(next.thinkingMode, state.thinkingMode);
  });

  it("keeps raw TodoWrite calls out of normal activity state", () => {
    let state = createInitialState("model");
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "tool_start", call: { id: "todo-1", name: "TodoWrite", arguments: { todos: [] } } },
    });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: {
        type: "tool_end",
        call: { id: "todo-1", name: "TodoWrite", arguments: { todos: [] } },
        result: { content: "Todo list updated", isError: false },
      },
    });

    assert.deepEqual(state.messages, []);
    assert.deepEqual(state.steps, []);
    assert.deepEqual(state.toolCards, []);
    assert.equal(state.status, "任务列表已更新");
  });
});

describe("TodoPanel formatting", () => {
  it("shows a compact progress meter without adding a panel row", () => {
    assert.equal(todoProgressMeter(2, 4), "▰▰▰▱▱▱");
    assert.equal(todoProgressMeter(0, 0), "······");
  });

  it("renders status symbols and active form text via the unified panel", () => {
    const todos: TodoItem[] = [
      { id: "done", content: "Read config", activeForm: "Reading config", status: "completed", source: "model" as const },
      { id: "active", content: "Run tests", activeForm: "Running tests", status: "in_progress", source: "model" as const },
      { id: "next", content: "Review output", activeForm: "Reviewing output", status: "pending", source: "model" as const },
    ];

    const panel = TodoPanel({ todos })!;
    const rendered = JSON.stringify(panel);

    // Unified panel renders item content with per-status icons/colors.
    assert.ok(rendered.includes("Read config"));
    assert.ok(rendered.includes("Run tests"));
    assert.ok(rendered.includes("Review output"));
    // Summary header reports the completed/total line.
    assert.ok(rendered.includes("completed"));
    assert.ok(rendered.includes("in progress"));
  });

  it("limits visible rows and reports overflow", () => {
    const todos: TodoItem[] = Array.from({ length: 10 }, (_, index) => ({
      id: String(index),
      content: `Task ${index}`,
      activeForm: `Tasking ${index}`,
      status: "pending" as const,
      source: "model" as const,
    }));

    assert.equal(getTodoPanelRows({ todos }), 10); // header + 8 visible + overflow row
  });

  it("uses no rows when both sources are absent or hidden", () => {
    assert.equal(getTodoPanelRows({}, "expanded"), 0);
    assert.equal(getTodoPanelRows({ todos: [{ id: "x", content: "x", activeForm: "x", status: "pending", source: "model" as const }] }, "hidden"), 0);
    assert.equal(getTodoPanelRows({ todos: [{ id: "x", content: "x", activeForm: "x", status: "pending", source: "model" as const }] }, "compact"), 2);
  });

  it("derives items from a plan document", () => {
    const plan = {
      id: "plan-1",
      title: "Plan",
      status: "approved" as const,
      steps: [
        { index: 1, text: "Step one", status: "done" as const },
        { index: 2, text: "Step two", status: "doing" as const },
      ],
    };
    const items = planToTodoItems(plan as any);

    assert.equal(items.length, 2);
    assert.equal(items[0].status, "completed");
    assert.equal(items[1].status, "in_progress");
  });

  it("reserves todo rows from the message feed", () => {
    const base = getMessageFeedHeight({ termRows: 24 });
    const withTodos = getMessageFeedHeight({ termRows: 24, todoRows: 4 });

    assert.equal(base - withTodos, 4);
  });

  it("reserves todo rows when sizing autocomplete pickers", () => {
    const withoutTodos = getPickerLayout({ termRows: 20, requestedItems: 12, extraRows: 3 });
    const withTodos = getPickerLayout({ termRows: 20, requestedItems: 12, todoRows: 4, extraRows: 3 });

    assert.ok(withTodos.itemRows < withoutTodos.itemRows);
  });
});
