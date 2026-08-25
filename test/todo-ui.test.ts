import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTodoCommand, todoViewModeForCommand } from "../src/tui/todo-commands.ts";
import { normalizeTodoText, normalizeTodoWriteInput } from "../src/todo.ts";

describe("Todo UI helpers", () => {
  it("parses /tasks consistently for both TUI clients", () => {
    assert.equal(parseTodoCommand("/tasks"), "toggle");
    assert.equal(parseTodoCommand(" /tasks COMPACT "), "compact");
    assert.equal(parseTodoCommand("/tasks clear"), "clear");
    assert.equal(parseTodoCommand("/task"), undefined);
    assert.equal(todoViewModeForCommand("toggle", "expanded"), "compact");
    assert.equal(todoViewModeForCommand("toggle", "hidden"), "expanded");
    assert.equal(todoViewModeForCommand("hide", "expanded"), "hidden");
  });

  it("uses one text normalization rule and stable IDs across status updates", () => {
    assert.equal(normalizeTodoText("  Edit\n  source   files "), "Edit source files");
    const first = normalizeTodoWriteInput({
      todos: [{ content: "Edit files", activeForm: "Editing files", status: "pending" }],
    });
    const second = normalizeTodoWriteInput({
      todos: [{ content: "Edit files", activeForm: "Editing files", status: "completed" }],
    });
    assert.equal(first[0]?.id, second[0]?.id);
  });
});
