import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contentAsString } from "../src/content.ts";
import { createTodoTool, type TodoItem } from "../src/tools/todo.ts";

const validTodos: TodoItem[] = [
  { id: "read", content: "Read the config", status: "completed" },
  { id: "test", content: "Run tests", status: "in_progress", activeForm: "Running tests" },
  { id: "review", content: "Review the result", status: "pending" },
];

describe("todo_write tool", () => {
  it("accepts a valid snapshot and invokes the callback once", async () => {
    const updates: TodoItem[][] = [];
    const tool = createTodoTool((todos) => { updates.push(todos); });

    const result = await tool.execute({ todos: validTodos });

    assert.equal(result.isError, undefined);
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], validTodos);
    assert.match(contentAsString(result.content), /pending=1/);
    assert.match(contentAsString(result.content), /in_progress=1/);
    assert.match(contentAsString(result.content), /completed=1/);
  });

  it("normalizes whitespace before updating the visible snapshot", async () => {
    const updates: TodoItem[][] = [];
    const tool = createTodoTool((todos) => { updates.push(todos); });

    const result = await tool.execute({
      todos: [{ id: "  test ", content: " Run tests ", status: "pending", activeForm: " Running tests " }],
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(updates, [[{ id: "test", content: "Run tests", status: "pending", activeForm: "Running tests" }]]);
  });

  it("rejects invalid snapshots without invoking the callback", async () => {
    const updates: TodoItem[][] = [];
    const tool = createTodoTool((todos) => { updates.push(todos); });

    const result = await tool.execute({
      todos: [
        { id: "same", content: "One", status: "in_progress" },
        { id: "same", content: "Two", status: "in_progress" },
      ],
    });

    assert.equal(result.isError, true);
    assert.match(contentAsString(result.content), /unique|in_progress/i);
    assert.deepEqual(updates, []);
  });

  it("rejects blank content and invalid active form values", async () => {
    const tool = createTodoTool(() => { throw new Error("callback must not run"); });

    const blank = await tool.execute({ todos: [{ id: "blank", content: "  ", status: "pending" }] });
    assert.equal(blank.isError, true);
    assert.match(contentAsString(blank.content), /content/i);

    const invalidActiveForm = await tool.execute({
      todos: [{ id: "active", content: "Work", status: "in_progress", activeForm: 42 as unknown as string }],
    });
    assert.equal(invalidActiveForm.isError, true);
    assert.match(contentAsString(invalidActiveForm.content), /activeForm/i);
  });

  it("allows an empty snapshot to clear the list", async () => {
    const updates: TodoItem[][] = [];
    const result = await createTodoTool((todos) => { updates.push(todos); }).execute({ todos: [] });

    assert.equal(result.isError, undefined);
    assert.deepEqual(updates, [[]]);
  });

  it("awaits an async callback before reporting success", async () => {
    let release!: () => void;
    const persistenceComplete = new Promise<void>((resolve) => { release = resolve; });
    let persisted = false;
    const execution = createTodoTool(async () => {
      await persistenceComplete;
      persisted = true;
    }).execute({ todos: validTodos });
    let executionSettled = false;
    execution.then(() => { executionSettled = true; });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(executionSettled, false);
    assert.equal(persisted, false);
    release();
    const result = await execution;

    assert.equal(result.isError, undefined);
    assert.equal(persisted, true);
  });

  it("reports callback failures as todo update failures", async () => {
    const result = await createTodoTool(async () => {
      throw new Error("disk full");
    }).execute({ todos: validTodos });

    assert.equal(result.isError, true);
    assert.equal(contentAsString(result.content), "Todo update failed: disk full");
  });
});
