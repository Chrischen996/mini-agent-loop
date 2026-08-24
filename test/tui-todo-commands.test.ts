import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyTodoCommand, parseTodoCommand, type TodoCommand } from "../src/tui/todo-commands.ts";
import { parseSlashCommand } from "../src/tui/slash-commands.ts";
import { PATH_COMMANDS } from "../src/tui/slash-commands.ts";
import { SLASH_COMMANDS } from "../src/tui/components/FileAutocomplete.tsx";
import type { TodoItem } from "../src/tools/todo.ts";

const todos: TodoItem[] = [
  { id: "todo-1", content: "First", status: "pending" },
  { id: "todo-2", content: "Running", status: "in_progress" },
];

describe("manual todo commands", () => {
  it("parses commands case-insensitively and exposes todo slash payloads", () => {
    assert.deepEqual(parseTodoCommand("/TODO add Buy milk"), { action: "add", content: "Buy milk" });
    assert.deepEqual(parseTodoCommand("todo START todo-1"), { action: "start", id: "todo-1" });
    assert.deepEqual(parseTodoCommand("/todo"), { action: "list" });
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
      { id: "todo-3", content: "Third", status: "pending" },
    ]);
    assert.notEqual(result.todos, todos);
    assert.notEqual(result.todos[0], todos[0]);
  });

  it("makes every in-progress transition exclusive", () => {
    for (const command of [
      { action: "start", id: "todo-1" },
      { action: "done", id: "todo-1" },
      { action: "pending", id: "todo-2" },
    ] as TodoCommand[]) {
      const result = applyTodoCommand(todos, command);
      assert.equal(result.ok, true);
    }
    const started = applyTodoCommand(todos, { action: "start", id: "todo-1" });
    assert.deepEqual(started.todos, [
      { id: "todo-1", content: "First", status: "in_progress" },
      { id: "todo-2", content: "Running", status: "pending" },
    ]);
  });

  it("rejects missing arguments, unknown ids, and blank content without mutation", () => {
    const cases = [
      parseTodoCommand("/todo add"),
      parseTodoCommand("/todo edit todo-1   "),
      parseTodoCommand("/todo start"),
      { action: "delete", id: "missing" } as TodoCommand,
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
    assert.deepEqual(edited.todos[0], { id: "todo-1", content: "Updated", status: "pending" });
    const deleted = applyTodoCommand(todos, { action: "delete", id: "todo-1" });
    assert.deepEqual(deleted.todos, [todos[1]]);
    const cleared = applyTodoCommand(todos, { action: "clear" });
    assert.deepEqual(cleared.todos, []);
    assert.ok(SLASH_COMMANDS.some((command) => command.name === "todo"));
    assert.equal(PATH_COMMANDS.has("todo"), false);
  });
});
