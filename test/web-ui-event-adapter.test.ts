import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ChatStreamState,
  historyToItems,
} from "../apps/web/src/lib/event-adapter.ts";
import type { HistoryMessage } from "../apps/web/src/types/api.ts";

describe("web ui event adapter (P3)", () => {
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
