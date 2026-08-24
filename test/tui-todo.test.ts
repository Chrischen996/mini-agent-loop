import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getTodoPanelRows, formatTodoPanel } from "../src/tui/components/TodoPanel.tsx";
import { createInitialState, tuiReducer } from "../src/tui/state.ts";
import { getMessageFeedHeight, getPickerLayout } from "../src/tui/layout.ts";
import type { TodoItem } from "../src/tools/todo.ts";
import { confirmTodoEditor, createTodoEditorState, reduceTodoEditor, type TodoEditorAction } from "../src/tui/todo-editor.ts";
import { routeTodoEditorKey } from "../src/tui/hooks/useKeyboardHandler.ts";

describe("TUI todo state", () => {
  const todos: TodoItem[] = [
    { id: "a", content: "First", status: "pending" },
    { id: "b", content: "Running", status: "in_progress" },
  ];

  it("cycles status exclusively and clamps selection after delete", () => {
    let editor = createTodoEditorState(todos);
    editor = reduceTodoEditor(editor, { type: "MOVE", delta: 1 });
    editor = reduceTodoEditor(editor, { type: "CYCLE_STATUS" });
    assert.deepEqual(editor.todos, [
      { id: "a", content: "First", status: "pending" },
      { id: "b", content: "Running", status: "completed" },
    ]);
    editor = reduceTodoEditor(editor, { type: "CYCLE_STATUS" });
    assert.deepEqual(editor.todos.map((todo) => todo.status), ["pending", "pending"]);
    editor = reduceTodoEditor(editor, { type: "CYCLE_STATUS" });
    assert.deepEqual(editor.todos.map((todo) => todo.status), ["pending", "in_progress"]);
    editor = reduceTodoEditor(editor, { type: "DELETE" });
    assert.equal(editor.selectedIndex, 0);
    assert.deepEqual(editor.todos, [{ id: "a", content: "First", status: "pending" }]);
  });

  it("confirms add and edit drafts and cancels without changing the snapshot", () => {
    let editor = createTodoEditorState(todos);
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
    let editor = reduceTodoEditor(createTodoEditorState(todos), { type: "BEGIN_ADD" });
    editor = reduceTodoEditor(editor, { type: "INPUT", value: "   " });
    const failed = reduceTodoEditor(editor, { type: "CONFIRM" });
    assert.deepEqual(failed.todos, todos);
    assert.equal(failed.mode, "add");
    assert.match(failed.error ?? "", /non-empty/i);
  });

  it("confirms the current editor snapshot for select-mode Enter", () => {
    let editor = createTodoEditorState(todos);
    editor = reduceTodoEditor(editor, { type: "DELETE" });
    const confirmed = confirmTodoEditor(editor);
    assert.deepEqual(confirmed.todos, [{ id: "b", content: "Running", status: "in_progress" }]);
    assert.equal(confirmed, editor);
  });

  it("routes editor keys by mode and preserves global guards", () => {
    const key = (overrides: Record<string, boolean> = {}) => overrides as never;
    assert.equal(routeTodoEditorKey({ editorOpen: false, mode: "select", acMode: null, busy: false, pendingPermission: false, ch: "t", key: key({ ctrl: true, shift: true }) }), "open");
    assert.equal(routeTodoEditorKey({ editorOpen: false, mode: "select", acMode: "command", busy: false, pendingPermission: false, ch: "t", key: key({ ctrl: true, shift: true }) }), "none");
    assert.equal(routeTodoEditorKey({ editorOpen: false, mode: "select", acMode: null, busy: true, pendingPermission: false, ch: "t", key: key({ ctrl: true, shift: true }) }), "none");
    assert.equal(routeTodoEditorKey({ editorOpen: false, mode: "select", acMode: null, busy: false, pendingPermission: false, ch: "t", key: key({ ctrl: true, shift: false }) }), "thinking");
    assert.equal(routeTodoEditorKey({ editorOpen: true, mode: "select", acMode: null, busy: true, pendingPermission: false, ch: "d", key: key() }), "delete");
    assert.equal(routeTodoEditorKey({ editorOpen: true, mode: "select", acMode: null, busy: true, pendingPermission: false, ch: "x", key: key({ escape: true }) }), "close");
    assert.equal(routeTodoEditorKey({ editorOpen: true, mode: "add", acMode: null, busy: false, pendingPermission: false, ch: "x", key: key() }), "prompt");
    assert.equal(routeTodoEditorKey({ editorOpen: true, mode: "edit", acMode: null, busy: false, pendingPermission: true, ch: "x", key: key() }), "permission");
  });

  it("replaces the independent todo snapshot", () => {
    const todos: TodoItem[] = [{ id: "a", content: "Run tests", status: "in_progress" }];
    const next = tuiReducer(createInitialState("model"), { type: "SET_TODOS", todos });

    assert.deepEqual(next.todos, todos);
  });

  it("clears todos on reset while preserving global display settings", () => {
    const state = {
      ...createInitialState("model"),
      todos: [{ id: "a", content: "Done", status: "completed" as const }],
    };
    const next = tuiReducer(state, { type: "RESET" });

    assert.deepEqual(next.todos, []);
    assert.equal(next.permissionMode, state.permissionMode);
    assert.equal(next.thinkingMode, state.thinkingMode);
  });

  it("keeps raw todo_write calls out of normal activity state", () => {
    let state = createInitialState("model");
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "tool_start", call: { id: "todo-1", name: "todo_write", arguments: { todos: [] } } },
    });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: {
        type: "tool_end",
        call: { id: "todo-1", name: "todo_write", arguments: { todos: [] } },
        result: { content: "Todo list updated", isError: false },
      },
    });

    assert.deepEqual(state.messages, []);
    assert.deepEqual(state.steps, []);
    assert.deepEqual(state.toolCards, []);
    assert.equal(state.status, "任务清单已更新");
  });
});

describe("TodoPanel formatting", () => {
  it("renders status symbols and active form text", () => {
    const todos: TodoItem[] = [
      { id: "done", content: "Read config", status: "completed" },
      { id: "active", content: "Run tests", status: "in_progress", activeForm: "Running tests" },
      { id: "next", content: "Review output", status: "pending" },
    ];

    const lines = formatTodoPanel(todos);

    assert.equal(lines[0], "TODO 1/3");
    assert.match(lines[1] ?? "", /✓.*Read config/);
    assert.match(lines[2] ?? "", /▶.*Running tests/);
    assert.doesNotMatch(lines[2] ?? "", /Run tests/);
    assert.match(lines[3] ?? "", /○.*Review output/);
  });

  it("limits visible rows and reports overflow", () => {
    const todos: TodoItem[] = Array.from({ length: 8 }, (_, index) => ({
      id: String(index),
      content: `Task ${index}`,
      status: "pending" as const,
    }));

    const lines = formatTodoPanel(todos);

    assert.equal(getTodoPanelRows(todos), 8);
    assert.equal(lines.length, 8);
    assert.match(lines.at(-1) ?? "", /2 more/);
  });

  it("uses no rows for an empty list", () => {
    assert.deepEqual(formatTodoPanel([]), []);
    assert.equal(getTodoPanelRows([]), 0);
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
