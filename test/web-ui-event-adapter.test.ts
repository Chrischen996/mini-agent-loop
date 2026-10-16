import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ChatStreamState,
  historyToItems,
} from "../apps/web/src/lib/event-adapter.ts";
import type { HistoryMessage } from "../apps/web/src/types/api.ts";

describe("web ui event adapter (P3)", () => {
  it("keeps uploaded file names in the user message without exposing document text", () => {
    const items = historyToItems([{
      role: "user",
      content: [
        { type: "text", text: "Summarize these files" },
        { type: "image", mimeType: "image/png", data: "hidden-image-data", source: "diagram.png" },
        { type: "text", text: "[Attached document: notes.pdf, 2 page(s), attachmentId=a1]\nprivate document body\n[End attached document: notes.pdf]" },
      ],
    }]);
    assert.deepEqual(items, [{
      id: items[0]?.id,
      kind: "user",
      text: "Summarize these files",
      attachments: ["diagram.png", "notes.pdf"],
    }]);
    assert.equal(items[0]?.kind === "user" && items[0].text.includes("private document body"), false);
  });

  it("shows uploaded file names from the live message event", () => {
    const state = new ChatStreamState();
    state.apply({ type: "user", content: "Review these files", images: ["chart.webp"], documents: ["report.docx"] });
    assert.deepEqual(state.items[0], { id: state.items[0]?.id, kind: "user", text: "Review these files", attachments: ["chart.webp", "report.docx"] });
  });

  it("pairs assistant tool calls with tool result messages from history", () => {
    const messages: HistoryMessage[] = [
      { role: "user", content: "run ls" },
      {
        role: "assistant",
        id: "a1",
        content: "listing files",
        toolCalls: [{ id: "t1", name: "bash", arguments: { command: "ls" } }],
      },
      { role: "tool", toolCallId: "t1", name: "bash", content: "file.txt\n", isError: false },
    ];
    const items = historyToItems(messages);
    const kinds = items.map((item) => item.kind);
    assert.deepEqual(kinds, ["user", "assistant", "tool"]);
    const tool = items[2]!;
    assert.equal(tool.kind, "tool");
    if (tool.kind === "tool") {
      assert.equal(tool.toolCallId, "t1");
      assert.equal(tool.status, "ok");
      assert.match(tool.preview, /file\.txt/);
    }
  });

  it("numbers a read result from the call offset", () => {
    const items = historyToItems([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "r1", name: "read", arguments: { path: "src/loop.ts", offset: 12 } }],
      },
      { role: "tool", toolCallId: "r1", name: "read", content: "alpha\nbeta\n", isError: false },
    ]);
    const tool = items.find((item) => item.kind === "tool");
    assert.ok(tool);
    if (tool?.kind === "tool") {
      assert.equal(tool.path, "src/loop.ts");
      assert.equal(tool.startLine, 12);
      assert.match(tool.preview, /alpha/);
    }
  });

  it("marks failed tool results as errors", () => {
    const items = historyToItems([
      {
        role: "assistant",
        toolCalls: [{ id: "t9", name: "bash", arguments: null }],
        content: "",
      },
      { role: "tool", toolCallId: "t9", name: "bash", content: "boom", isError: true },
    ]);
    const tool = items[0]!;
    assert.equal(tool.kind, "tool");
    if (tool.kind === "tool") assert.equal(tool.status, "error");
  });

  it("streams a full user -> deltas -> tool -> done sequence", () => {
    const state = new ChatStreamState();
    state.apply({ type: "user", content: "hi" });
    state.apply({ type: "assistant_delta", text: "Hel", kind: "answer" });
    state.apply({ type: "assistant_delta", text: "lo", kind: "answer" });
    state.apply({ type: "assistant_deltas", reasoning: "thinking…" });
    state.apply({ type: "tool_start", id: "c1", name: "bash", arguments: { command: "pwd" } });
    state.apply({ type: "tool_end", id: "c1", name: "bash", isError: false, preview: "/tmp" });
    state.apply({ type: "assistant" });
    state.apply({ type: "done", messageCount: 4 });

    assert.equal(state.phase, "done");
    const assistant = state.items.find((item) => item.kind === "assistant");
    assert.ok(assistant);
    if (assistant.kind === "assistant") {
      assert.equal(assistant.text, "Hello");
      assert.equal(assistant.reasoning, "thinking…");
      assert.equal(assistant.streaming, false);
    }
    const tool = state.items.find((item) => item.kind === "tool");
    assert.ok(tool);
    if (tool.kind === "tool") {
      assert.equal(tool.status, "ok");
      assert.equal(tool.preview, "/tmp");
    }
  });

  it("ends with error/aborted phases and notes", () => {
    const state = new ChatStreamState();
    state.apply({ type: "user", content: "hi" });
    state.apply({ type: "error", message: "model unavailable" });
    assert.equal(state.phase, "error");
    const lastItem = state.items[state.items.length - 1]!;
    assert.equal(lastItem.kind, "note");
    if (lastItem.kind === "note") assert.match(lastItem.text, /model unavailable/);

    const aborted = new ChatStreamState();
    aborted.apply({ type: "user", content: "hi" });
    aborted.apply({ type: "assistant_delta", text: "partial", kind: "answer" });
    aborted.apply({ type: "aborted", message: "已停止生成" });
    assert.equal(aborted.phase, "aborted");
    const assistant = aborted.items.find((item) => item.kind === "assistant");
    assert.ok(assistant);
    if (assistant.kind === "assistant") assert.equal(assistant.streaming, false);
  });

  it("keeps automatic continuation active and ends the total limit as a recoverable stop", () => {
    const state = new ChatStreamState();
    state.apply({ type: "user", content: "finish the task" });
    state.apply({ type: "assistant_delta", text: "partial progress", kind: "answer" });
    state.apply({ type: "auto_continue", attempt: 1, maxAutoContinues: 4 });
    assert.equal(state.phase, "streaming");
    state.apply({ type: "max_turns", maxTurns: 150, messageCount: 311 });
    assert.equal(state.phase, "paused");
    assert.equal(state.items.some((item) => item.kind === "assistant" && item.streaming), false);
    const note = state.items.at(-1);
    assert.ok(note?.kind === "note");
    assert.equal(note.tone, "warn");
    assert.match(note.text, /progress saved.*Continue to resume/);
    assert.equal(state.items.some((item) => item.kind === "note" && item.tone === "error"), false);
  });

  it("ignores unknown event types but surfaces plan events", () => {
    const state = new ChatStreamState();
    state.apply({ type: "user", content: "plan something" });
    state.apply({ type: "totally_new_event", payload: 1 });
    state.apply({ eventType: "plan_step_completed" });
    assert.equal(state.phase, "streaming");
    const planNote = state.items.find(
      (item) => item.kind === "note" && item.text === "Plan event: plan_step_completed",
    );
    assert.ok(planNote);
  });

  it("keeps two stream states isolated from each other", () => {
    const first = new ChatStreamState();
    const second = new ChatStreamState();
    first.apply({ type: "user", content: "first session" });
    assert.deepEqual(second.items, []);
    assert.equal(second.phase, "idle");
  });
});

describe("web ui event adapter (P3 review fixes)", () => {
  it("renders assistant content when no deltas were streamed", () => {
    const state = new ChatStreamState();
    state.apply({ type: "user", content: "hi" });
    state.apply({ type: "assistant", content: "direct reply", tools: [] });
    const assistant = state.items.find((item) => item.kind === "assistant");
    assert.ok(assistant, "assistant item should exist");
    if (assistant.kind === "assistant") {
      assert.equal(assistant.text, "direct reply");
      assert.equal(assistant.streaming, false);
    }
  });

  it("does not duplicate text when deltas and the assistant event both carry content", () => {
    const state = new ChatStreamState();
    state.apply({ type: "user", content: "hi" });
    state.apply({ type: "assistant_delta", text: "Hel", kind: "answer" });
    state.apply({ type: "assistant_delta", text: "lo", kind: "answer" });
    // The boundary event carries the same full content - it must not be appended again.
    state.apply({ type: "assistant", content: "Hello", tools: [] });
    const assistant = state.items.find((item) => item.kind === "assistant");
    assert.ok(assistant);
    if (assistant.kind === "assistant") {
      assert.equal(assistant.text, "Hello");
      assert.equal(assistant.streaming, false);
    }
  });

  it("multi-turn send preserves previous items (simulated via items seeding)", () => {
    // Simulates useAgentStream seeding a fresh ChatStreamState with the
    // previous conversation, then streaming the next turn.
    const history = new ChatStreamState();
    history.apply({ type: "user", content: "first" });
    history.apply({ type: "assistant_delta", text: "one", kind: "answer" });
    history.apply({ type: "assistant", content: "one" });
    history.apply({ type: "done", messageCount: 2 });

    const next = new ChatStreamState();
    next.items = [...history.items];
    next.apply({ type: "user", content: "second" });
    next.apply({ type: "assistant_delta", text: "two", kind: "answer" });
    next.apply({ type: "done", messageCount: 4 });

    const userItems = next.items.filter((item) => item.kind === "user");
    assert.deepEqual(
      userItems.map((item) => (item.kind === "user" ? item.text : "")),
      ["first", "second"],
    );
    assert.equal(next.items.length, 4);
  });
});


describe("Web policy pause details", () => {
  it("shows safety stops with allocation limits and session totals", () => {
    const state = new ChatStreamState();
    state.apply({ type: "assistant_delta", kind: "answer", text: "working" });
    state.apply({
      type: "run_stopped", stopReason: "safety_cap_reached",
      budgetUsage: { tokensUsed: 20, toolCallsUsed: 2, writeCallsUsed: 1, elapsedMs: 1500 },
      cumulativeBudgetUsage: { tokensUsed: 50, toolCallsUsed: 5, writeCallsUsed: 2, elapsedMs: 3000 },
      budgetPolicy: { tokenBudget: 100, toolCallBudget: 10, writeCallBudget: 5, deadlineMs: 300000 },
    });
    assert.equal(state.phase, "paused");
    const notes = state.items.filter((item) => item.kind === "note");
    assert.equal(notes.length, 1);
    assert.match(notes[0]!.text, /emergency iteration cap/);
    assert.match(notes[0]!.text, /20\/100 tokens, 2\/10 tool calls, 1\/5 writes, 1.5\/300.0 seconds/);
    assert.match(notes[0]!.text, /Session total: 50 tokens, 5 tool calls, 2 writes, 3.0 seconds/);
    assert.match(notes[0]!.text, /new budget/);
    assert.equal(state.items[0]!.kind === "assistant" && state.items[0]!.streaming, false);
  });
});
