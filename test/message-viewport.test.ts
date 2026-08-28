import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage } from "../src/tui/state.ts";
import {
  clampScrollOffset,
  selectMessageViewport,
} from "../src/tui/message-viewport.ts";

function user(text: string): ChatMessage {
  return { kind: "user", text };
}

function assistant(text: string): ChatMessage {
  return { kind: "assistant", text };
}

describe("message viewport", () => {
  it("keeps the latest messages when pinned to bottom", () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(user(`u${i}`), assistant(`a${i}`));
    }

    const viewport = selectMessageViewport({
      messages,
      streamingText: "",
      streamingReasoning: "",
      busy: false,
      thinkingMode: "hidden",
      expandedThinking: [],
      scrollOffset: 0,
      availableHeight: 8,
      width: 80,
    });

    assert.equal(viewport.pinnedToBottom, true);
    assert.ok(viewport.hiddenAbove > 0);
    const messageItems = viewport.items.filter((item) => item.kind === "message");
    assert.ok(messageItems.length > 0);
    assert.ok(messageItems.length < messages.length);
    const last = messageItems.at(-1);
    assert.equal(last?.kind, "message");
    if (last?.kind === "message") {
      assert.equal(last.index, messages.length - 1);
    }
  });

  it("scrolls upward by hiding trailing messages", () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 12; i++) messages.push(user(`msg-${i}`));

    const bottom = selectMessageViewport({
      messages,
      streamingText: "",
      streamingReasoning: "",
      busy: false,
      thinkingMode: "hidden",
      expandedThinking: [],
      scrollOffset: 0,
      availableHeight: 5,
      width: 80,
    });
    const scrolled = selectMessageViewport({
      messages,
      streamingText: "",
      streamingReasoning: "",
      busy: false,
      thinkingMode: "hidden",
      expandedThinking: [],
      scrollOffset: 3,
      availableHeight: 5,
      width: 80,
    });

    const bottomIds = bottom.items
      .filter((item): item is Extract<typeof item, { kind: "message" }> => item.kind === "message")
      .map((item) => item.index);
    const scrolledIds = scrolled.items
      .filter((item): item is Extract<typeof item, { kind: "message" }> => item.kind === "message")
      .map((item) => item.index);

    assert.ok(scrolledIds.every((id) => id <= Math.max(...bottomIds) - 3 + 2));
    assert.ok(!scrolledIds.includes(messages.length - 1));
    assert.equal(scrolled.pinnedToBottom, false);
    assert.ok(scrolled.items.some((item) => item.kind === "history_hint"));
  });

  it("keeps partially visible streaming rows while scrolling by terminal row", () => {
    const messages = [user("hello"), assistant("world")];
    const streamingText = Array.from({ length: 30 }, (_, index) => `partial-${index}`).join("\n");
    const pinned = selectMessageViewport({
      messages,
      streamingText,
      streamingReasoning: "think",
      busy: true,
      thinkingMode: "summary",
      expandedThinking: [],
      scrollOffset: 0,
      availableHeight: 8,
      width: 80,
    });
    const scrolled = selectMessageViewport({
      messages,
      streamingText,
      streamingReasoning: "think",
      busy: true,
      thinkingMode: "summary",
      expandedThinking: [],
      scrollOffset: 1,
      availableHeight: 8,
      width: 80,
    });

    assert.ok(pinned.items.some((item) => item.kind === "streaming_text"));
    assert.ok(pinned.items.some((item) => item.kind === "busy_status"));
    assert.equal(scrolled.items.some((item) => item.kind === "streaming_text"), true);
    assert.ok(scrolled.items.some((item) => item.kind === "history_hint" && item.direction === "below"));
  });

  it("clips within a single long assistant message", () => {
    const text = Array.from({ length: 40 }, (_, index) => `line-${index}`).join("\n");
    const bottom = selectMessageViewport({
      messages: [assistant(text)],
      streamingText: "",
      streamingReasoning: "",
      busy: false,
      thinkingMode: "hidden",
      expandedThinking: [],
      scrollOffset: 0,
      availableHeight: 8,
      width: 80,
    });
    const message = bottom.items.find((item) => item.kind === "message");
    assert.equal(message?.kind, "message");
    if (message?.kind === "message") {
      assert.ok(message.clipTop > 0);
      assert.ok(message.visibleHeight < 40);
    }
    assert.ok(bottom.hiddenAbove > 0);

    const top = selectMessageViewport({
      messages: [assistant(text)],
      streamingText: "",
      streamingReasoning: "",
      busy: false,
      thinkingMode: "hidden",
      expandedThinking: [],
      scrollOffset: bottom.maxScrollOffset,
      availableHeight: 8,
      width: 80,
    });
    const topMessage = top.items.find((item) => item.kind === "message");
    assert.equal(topMessage?.kind === "message" ? topMessage.clipTop : -1, 0);
    assert.ok(top.hiddenBelow > 0);
  });

  it("uses terminal display width for Chinese and emoji", () => {
    const viewport = selectMessageViewport({
      messages: [assistant("中文中文中文中文中文中文\n🙂🙂🙂🙂🙂🙂")],
      streamingText: "",
      streamingReasoning: "",
      busy: false,
      thinkingMode: "hidden",
      expandedThinking: [],
      scrollOffset: 0,
      availableHeight: 3,
      width: 20,
    });
    assert.equal(viewport.totalHeight, 3);
  });

  it("clamps scroll offsets to message bounds", () => {
    assert.equal(clampScrollOffset(-3, 10), 0);
    assert.equal(clampScrollOffset(3, 10), 3);
    assert.equal(clampScrollOffset(99, 10), 10);
    assert.equal(clampScrollOffset(1, 0), 0);
  });

  it("can omit history hint rows without reducing the visible message budget", () => {
    const messages = Array.from({ length: 12 }, (_, index) => user(`msg-${index}`));
    const viewport = selectMessageViewport({
      messages,
      streamingText: "",
      streamingReasoning: "",
      busy: false,
      thinkingMode: "hidden",
      expandedThinking: [],
      scrollOffset: 3,
      availableHeight: 5,
      width: 80,
      showHistoryHints: false,
    });

    assert.ok(viewport.hiddenAbove > 0);
    assert.ok(viewport.hiddenBelow > 0);
    assert.equal(viewport.items.some((item) => item.kind === "history_hint"), false);
  });
});
