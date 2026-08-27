import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { thinkingRenderLines } from "../src/tui/thinking-lines.ts";
import { todoPanelRenderLines } from "../src/tui/todo-lines.ts";
import type { TodoItem } from "../src/todo.ts";

describe("TUI shared render lines", () => {
  it("collapses long thinking content without changing source text", () => {
    const source = Array.from({ length: 5 }, (_, index) => `line ${index + 1}`).join("\n");
    const lines = thinkingRenderLines(source, { mode: "summary" });
    assert.deepEqual(lines.slice(0, 3).map((line) => line.text), ["line 1", "line 2", "line 3"]);
    assert.equal(lines.at(-1)?.text, "··· 2 more lines");
    assert.equal(source.split("\n").length, 5);
  });

  it("builds Todo lines from the existing Todo snapshot", () => {
    const todos: TodoItem[] = [
      { id: "done", content: "Read files", activeForm: "Reading files", status: "completed", source: "model" },
      { id: "active", content: "Run tests", activeForm: "Running tests", status: "in_progress", source: "model" },
    ];
    const lines = todoPanelRenderLines({ todos });
    assert.match(lines[0]!.text, /1\/2 已完成/);
    assert.equal(lines[1]!.text, "☒ Read files");
    assert.equal(lines[1]!.strikethrough, true);
    assert.equal(lines[2]!.text, "… Run tests");

    const planLines = todoPanelRenderLines({ plan: {
      version: 2, id: "p", prompt: "p", rawMarkdown: "1. Read files", files: [], status: "approved",
      createdAt: "", updatedAt: "", cwd: "/tmp", steps: [{ index: 1, text: "Read files", status: "todo" }],
    } });
    assert.equal(planLines[1]!.text, "☐ 1. Read files");
  });
});
