import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyTodoCommand,
  executeTodoCommand,
  parseLegacyTodoCommand,
  type LegacyTodoCommand,
} from "../src/tui/todo-commands.ts";
import { parseSlashCommand, PATH_COMMANDS } from "../src/tui/slash-commands.ts";
import { SLASH_COMMANDS } from "../src/tui/components/FileAutocomplete.tsx";
import type { TodoItem } from "../src/todo.ts";
import { createInitialState, tuiReducer, type TuiAction } from "../src/tui/state.ts";

const todos: TodoItem[] = [
  { id: "todo-1", content: "First", activeForm: "First", status: "pending", source: "model" },
  { id: "todo-2", content: "Running", activeForm: "Running", status: "in_progress", source: "model" },
];

describe("manual todo commands", () => {
  it("parses commands case-insensitively and exposes todo slash payloads", () => {
    assert.deepEqual(parseLegacyTodoCommand("/TODO add Buy milk"), { action: "add", content: "Buy milk" });
    assert.deepEqual(parseLegacyTodoCommand("todo START todo-1"), { action: "start", id: "todo-1" });
    assert.deepEqual(parseLegacyTodoCommand("/todo"), { action: "list" });
    assert.deepEqual(parseSlashCommand("/todo done todo-1"), {
      cmd: "todo",
      todo: { action: "done", id: "todo-1" },
    });
  });

  it("adds the smallest available id and returns an isolated snapshot", () => {
    const result = applyTodoCommand(todos, { action: "add", content: "Third" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.todos, [
      ...todos,
      { id: "todo-3", content: "Third", activeForm: "Third", status: "pending", source: "model" },
    ]);
    assert.notEqual(result.todos, todos);
    assert.notEqual(result.todos[0], todos[0]);
  });

  it("makes every in-progress transition exclusive", () => {
    for (const command of [
      { action: "start", id: "todo-1" },
      { action: "done", id: "todo-1" },
      { action: "pending", id: "todo-2" },
    ] as LegacyTodoCommand[]) {
      const result = applyTodoCommand(todos, command);
      assert.equal(result.ok, true);
    }
    const started = applyTodoCommand(todos, { action: "start", id: "todo-1" });
    assert.deepEqual(started.todos, [
      { id: "todo-1", content: "First", activeForm: "First", status: "in_progress", source: "model" },
      { id: "todo-2", content: "Running", activeForm: "Running", status: "pending", source: "model" },
    ]);
  });

  it("rejects missing arguments, unknown ids, and blank content without mutation", () => {
    const cases = [
      parseLegacyTodoCommand("/todo add"),
      parseLegacyTodoCommand("/todo edit todo-1   "),
      parseLegacyTodoCommand("/todo start"),
      { action: "delete", id: "missing" } as LegacyTodoCommand,
    ];
    for (const command of cases) {
      if (!command) {
        assert.equal(command, null);
        continue;
      }
      const result = applyTodoCommand(todos, command);
      assert.equal(result.ok, false);
      assert.deepEqual(result.todos, todos);
      assert.notEqual(result.todos, todos);
    }
    const blankAdd = applyTodoCommand(todos, { action: "add", content: " " });
    assert.equal(blankAdd.ok, false);
    assert.deepEqual(blankAdd.todos, todos);
  });

  it("edits, deletes, clears, and keeps todo out of path autocomplete", () => {
    const edited = applyTodoCommand(todos, { action: "edit", id: "todo-1", content: "Updated" });
    assert.deepEqual(edited.todos[0], { id: "todo-1", content: "Updated", activeForm: "Updated", status: "pending", source: "model" });
    const deleted = applyTodoCommand(todos, { action: "delete", id: "todo-1" });
    assert.deepEqual(deleted.todos, [todos[1]]);
    const cleared = applyTodoCommand(todos, { action: "clear" });
    assert.deepEqual(cleared.todos, []);
    assert.ok(SLASH_COMMANDS.some((command) => command.name === "todo"));
    assert.equal(PATH_COMMANDS.has("todo"), false);
  });

  it("dispatches todo updates and notices without creating a user turn", () => {
    let state = createInitialState("test");
    const actions: TuiAction[] = [];
    const dispatch = (action: TuiAction) => {
      actions.push(action);
      state = tuiReducer(state, action);
    };
    const command = parseLegacyTodoCommand("/todo add Ship it");
    assert.ok(command);
    executeTodoCommand(state.todos, command, dispatch);

    assert.deepEqual(state.todos, [{ id: "todo-1", content: "Ship it", activeForm: "Ship it", status: "pending", source: "model" }]);
    assert.deepEqual(actions.map((action) => action.type), ["SET_TODOS", "ADD_NOTICE"]);
    assert.match((actions[1] as Extract<TuiAction, { type: "ADD_NOTICE" }>).text, /Ship it/);

    actions.length = 0;
    const failed = parseLegacyTodoCommand("/todo delete missing");
    assert.ok(failed);
    executeTodoCommand(state.todos, failed, dispatch);
    assert.deepEqual(actions.map((action) => action.type), ["ADD_NOTICE"]);
    assert.deepEqual(state.todos, [{ id: "todo-1", content: "Ship it", activeForm: "Ship it", status: "pending", source: "model" }]);
  });
});
