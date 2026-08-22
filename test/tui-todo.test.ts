import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getTodoPanelRows, formatTodoPanel } from "../src/tui/components/TodoPanel.tsx";
import { createInitialState, tuiReducer } from "../src/tui/state.ts";
import { getMessageFeedHeight, getPickerLayout } from "../src/tui/layout.ts";
import type { TodoItem } from "../src/tools/todo.ts";

describe("TUI todo state", () => {
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
