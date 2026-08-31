import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLegacyFrameLines, buildLegacyFrameOutput, buildLegacyFrameRowCount } from "../src/tui/legacy-render.ts";
import { createPlanDocument } from "../src/plan/document.ts";
import type { TodoItem } from "../src/todo.ts";
import { getMessageFeedHeight, getPickerLayout, getTuiViewportHeight } from "../src/tui/layout.ts";

describe("legacy TUI renderer", () => {
  it("renders the persisted Todo plan and current step statuses", () => {
    const plan = createPlanDocument({
      prompt: "task",
      rawMarkdown: "1. Read\n2. Write",
      cwd: "/tmp",
    });
    plan.status = "executing";
    plan.steps![0]!.status = "done";
    plan.steps![1]!.status = "doing";

    const lines = buildLegacyFrameLines({
      history: [],
      streamingText: "",
      tools: [],
      busy: false,
      input: "",
      status: "就绪",
      permissionMode: "plan",
      thinkingLevel: "off",
      todoPlan: plan,
    });

    const rendered = lines.join("\n");
    assert.match(rendered, /Todos/);
    assert.match(rendered, /in progress/);
    assert.match(rendered, /1\. Read/);
    assert.match(rendered, /2\. Write/);
  });

  it("renders dynamic TodoWrite items with completed strike-through", () => {
    const todos: TodoItem[] = [
      { id: "todo-1", content: "Read files", activeForm: "Reading files", status: "completed", source: "model" },
      { id: "todo-2", content: "Edit code", activeForm: "Editing code", status: "in_progress", source: "model" },
    ];
    const lines = buildLegacyFrameLines({
      history: [],
      streamingText: "",
      tools: [],
      busy: false,
      input: "",
      status: "就绪",
      permissionMode: "plan",
      thinkingLevel: "off",
      todoItems: todos,
      todoRevision: 1,
      todoViewMode: "expanded",
    });
    const rendered = lines.join("\n");
    assert.match(rendered, /Todos/);
    assert.match(rendered, /Read files/);
    assert.match(rendered, /Edit code/);
    assert.match(rendered, /\x1b\[9m/);
  });

  it("keeps nested subagent protocol rows out of the legacy transcript", () => {
    const lines = buildLegacyFrameLines({
      history: [
        { role: "user", content: "Inspect the workspace" },
        { role: "assistant", content: "subagent(task=Inspect files, profile=researcher)" },
        { role: "assistant", content: "You are the researcher subagent for a parent orchestrator.\nUser request:\nInspect files" },
        { role: "tool", toolCallId: "subagent-1", name: "functions.subagent", content: "internal" },
        { role: "assistant", content: "The relevant files are ready." },
      ],
      streamingText: "",
      tools: [{ id: "subagent-1", name: "mcp.subagent_batch", status: "done", preview: "internal" }],
      busy: false,
      input: "",
      status: "就绪",
      permissionMode: "plan",
      thinkingLevel: "off",
    });
    const rendered = lines.join("\n");
    assert.match(rendered, /Inspect the workspace/);
    assert.match(rendered, /The relevant files are ready/);
    assert.doesNotMatch(rendered, /subagent\s*\(/i);
    assert.doesNotMatch(rendered, /You are the researcher/i);
    assert.doesNotMatch(rendered, /internal/);
  });

  it("does not expose inline Markdown markers in legacy assistant output", () => {
    const lines = buildLegacyFrameLines({
      history: [{ role: "assistant", content: "**Done** with `npm test`" }],
      streamingText: "",
      tools: [],
      busy: false,
      input: "",
      status: "就绪",
      permissionMode: "plan",
      thinkingLevel: "off",
    });
    const rendered = lines.join("\n");
    assert.match(rendered, /Done with npm test/);
    assert.doesNotMatch(rendered, /\*\*|`/);
  });

  it("does not render a completed tool twice while transient state is retained", () => {
    const lines = buildLegacyFrameLines({
      history: [
        { role: "user", content: "list files" },
        { role: "tool", toolCallId: "call-1", name: "bash", content: "file.txt" },
      ],
      streamingText: "",
      tools: [{ id: "call-1", name: "bash", status: "done", preview: "file.txt" }],
      busy: false,
      input: "",
      status: "就绪",
      permissionMode: "plan",
      thinkingLevel: "off",
    });

    const rendered = lines.join("\n");
    assert.equal((rendered.match(/Bash/g) ?? []).length, 1);
    assert.equal((rendered.match(/file\.txt/g) ?? []).length, 1);
  });

  it("updates frames without clearing the entire terminal", () => {
    const output = buildLegacyFrameOutput(["header", "thinking"], 2);
    assert.equal(output.includes("\x1b[2J"), false);
    assert.equal(output.startsWith("\x1b[H"), true);
    assert.equal(output.includes("\x1b[2Kheader"), true);
  });

  it("clears rows left by a longer previous frame", () => {
    const output = buildLegacyFrameOutput(["header"], 3);
    assert.equal(output.includes("\x1b[2K"), true);
    assert.equal(output.includes("\x1b[2;1H\x1b[2K"), true);
    assert.equal(output.includes("\x1b[3;1H\x1b[2K"), true);
  });

  it("counts wrapped and wide-character rows", () => {
    assert.equal(buildLegacyFrameRowCount(["123456789"], 5), 2);
    assert.equal(buildLegacyFrameRowCount(["中文中文"], 4), 2);
    const output = buildLegacyFrameOutput(["123456789"], 4, 5);
    assert.equal(output.includes("\x1b[3;1H\x1b[2K"), true);
    assert.equal(output.includes("\x1b[4;1H\x1b[2K"), true);
  });
});

describe("Ink TUI viewport", () => {
  it("reserves rows for the visible Todo panel", () => {
    const withoutTodo = getMessageFeedHeight({ termRows: 30 });
    const withTodo = getMessageFeedHeight({ termRows: 30, todoRows: 4 });
    assert.equal(withoutTodo - withTodo, 4);
  });

  it("always leaves one terminal row available for Ink's cursor protocol", () => {
    assert.equal(getTuiViewportHeight(24), 23);
    assert.equal(getTuiViewportHeight(1), 1);
    assert.equal(getTuiViewportHeight(undefined), 23);
  });

  it("reserves chrome rows for the message feed", () => {
    assert.ok(getMessageFeedHeight({ termRows: 24 }) < getTuiViewportHeight(24));
    assert.ok(getMessageFeedHeight({ termRows: 24 }) >= 3);
    assert.ok(
      getMessageFeedHeight({ termRows: 24, hasPendingImages: true, pickerRows: 6 })
        < getMessageFeedHeight({ termRows: 24 }),
    );
  });

  it("bounds picker rows while preserving a minimum message feed", () => {
    const picker = getPickerLayout({ termRows: 20, requestedItems: 12, extraRows: 3 });
    assert.ok(picker.itemRows < 12);
    assert.equal(picker.totalRows, picker.itemRows + 3);
    assert.ok(getMessageFeedHeight({ termRows: 20, pickerRows: picker.totalRows }) >= 3);
  });
});
