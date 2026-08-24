import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTodoWriteTool } from "../src/tools/todo-write.ts";
import { normalizeTodoWriteInput } from "../src/todo.ts";

describe("TodoWrite", () => {
  it("normalizes a complete replacement and exposes no execution capabilities", async () => {
    const tool = createTodoWriteTool();
    const result = await tool.execute({
      todos: [
        { content: "Read files", activeForm: "Reading files", status: "completed" },
        { content: "Edit code", activeForm: "Editing code", status: "in_progress" },
      ],
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.todoUpdate?.length, 2);
    assert.equal(result.todoUpdate?.[0]?.status, "completed");
    assert.equal(tool.capabilities?.writeWorkspace, false);
    assert.equal(tool.capabilities?.requiresApproval, false);
  });

  it("rejects duplicate tasks and multiple in-progress tasks", () => {
    assert.throws(
      () => normalizeTodoWriteInput({
        todos: [
          { content: "Same", activeForm: "Doing same", status: "pending" },
          { content: "same", activeForm: "Doing same again", status: "pending" },
        ],
      }),
      /duplicated/,
    );
    assert.throws(
      () => normalizeTodoWriteInput({
        todos: [
          { content: "One", activeForm: "Doing one", status: "in_progress" },
          { content: "Two", activeForm: "Doing two", status: "in_progress" },
        ],
      }),
      /only one todo may be in_progress/,
    );
  });

  it("allows an empty replacement to clear the current list", async () => {
    const result = await createTodoWriteTool().execute({ todos: [] });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.todoUpdate, []);
  });
});
