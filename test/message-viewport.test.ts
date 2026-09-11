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

  it("bounds streaming text height to the live tail", () => {
    const streamingText = Array.from({ length: 30 }, (_, index) => `partial-${index}`).join("\n");
    const viewport = selectMessageViewport({
      messages: [],
      streamingText,
      streamingReasoning: "",
      busy: true,
      thinkingMode: "hidden",
      expandedThinking: [],
      scrollOffset: 0,
      availableHeight: 40,
      width: 80,
    });
    // Live-stack top margin: no streaming_reasoning, so streaming_text
    // carries the 1-row gap (1 + compacted tail 11) and busy_status follows
    // with 0 (1 row). 12 was the pre-margin value.
    assert.equal(viewport.totalHeight, 13);
  });

  it("draws no rows for tool-only assistant messages", () => {
    const viewport = selectMessageViewport({
      messages: [user("hello"), assistant(""), assistant("world")],
      streamingText: "",
      streamingReasoning: "",
      busy: false,
      thinkingMode: "hidden",
      expandedThinking: [],
      scrollOffset: 0,
      availableHeight: 40,
      width: 80,
    });
    // user: 1-row gap + 1 text row; the empty tool-only assistant draws
    // nothing; "world": 1-row gap + 1 text row.
    assert.equal(viewport.totalHeight, 4);
    const messageItems = viewport.items.filter((item) => item.kind === "message");
    assert.deepEqual(messageItems.map((item) => item.index), [0, 2]);
  });

  it("ignores leading blank rows in live streaming text", () => {
    const options: Omit<Parameters<typeof selectMessageViewport>[0], "streamingText"> = {
      messages: [],
      streamingReasoning: "",
      busy: true,
      thinkingMode: "hidden",
      expandedThinking: [],
      scrollOffset: 0,
      availableHeight: 40,
      width: 80,
    };
    const withBlanks = selectMessageViewport({ ...options, streamingText: "\n\npartial-0\npartial-1" });
    const withoutBlanks = selectMessageViewport({ ...options, streamingText: "partial-0\npartial-1" });
    // Leading newlines must not reserve extra rows or draw a lone marker row.
    assert.equal(withBlanks.totalHeight, withoutBlanks.totalHeight);
    // 1-row live-stack gap + 2 content rows + 1 busy row.
    assert.equal(withBlanks.totalHeight, 4);
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

  it("never clips past the rows a block actually draws", () => {
    // A wide table row over-estimates to several rows but Ink draws one row
    // per source line. Scrolling into such a block must clamp clipTop inside
    // its real row budget, or the slice would push the content fully out of
    // the box and leave a blank band before the next block.
    const wideColumns = Array.from({ length: 12 }, (_, i) => `column-${i}`);
    const table = [
      `| ${wideColumns.join(" | ")} |`,
      `| ${Array(12).fill("---").join(" | ")} |`,
      `| ${Array.from({ length: 12 }, (_, i) => `value-${i}`).join(" | ")} |`,
    ].join("\n");
    const viewport = selectMessageViewport({
      messages: [assistant(`# Report\n${table}\n`)],
      streamingText: "",
      streamingReasoning: "",
      busy: false,
      thinkingMode: "hidden",
      expandedThinking: [],
      scrollOffset: 1,
      availableHeight: 2,
      width: 80,
    });
    const item = viewport.items.find((candidate) => candidate.kind === "message");
    assert.ok(item && "clipTop" in item && "actualHeight" in item);
    const block = item as { clipTop: number; actualHeight: number; visibleHeight: number };
    assert.ok(block.clipTop < block.actualHeight, `clipTop ${block.clipTop} must stay below actualHeight ${block.actualHeight}`);
    assert.ok(block.visibleHeight >= 1);
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
    // assistant messages include a marginTop={1} row accounted for in the height estimate.
    assert.equal(viewport.totalHeight, 4);
  });

  it("keeps more than 200 messages reachable by default", () => {
    const messages = Array.from({ length: 220 }, (_, index) => user(`msg-${index}`));
    const viewport = selectMessageViewport({
      messages,
      streamingText: "",
      streamingReasoning: "",
      busy: false,
      thinkingMode: "hidden",
      expandedThinking: [],
      scrollOffset: Number.MAX_SAFE_INTEGER,
      availableHeight: 5,
      width: 80,
    });

    const first = viewport.items.find((item) => item.kind === "message");
    assert.equal(first?.kind, "message");
    if (first?.kind === "message") assert.equal(first.index, 0);
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

import {
  estimateViewportActualHeight,
  estimateViewportContentHeight,
} from "../src/tui/message-viewport.ts";
import { countMarkdownRenderRows } from "../src/tui/markdown-lines.ts";
import { estimateThinkingRows } from "../src/tui/thinking-lines.ts";
import { subagentRenderLineCount } from "../src/tui/subagent-lines.ts";

describe("actual viewport heights", () => {
  const wideColumns = Array.from({ length: 20 }, (_, i) => `column-name-${i}`);
  const table = [
    `| ${wideColumns.join(" | ")} |`,
    `| ${Array(20).fill("---").join(" | ")} |`,
    `| ${Array.from({ length: 20 }, (_, i) => `value-${i}`).join(" | ")} |`,
  ].join("\n");
  const options = {
    messages: [assistant(`# Report\n${table}\n`)],
    streamingText: "",
    streamingReasoning: "",
    busy: false,
    thinkingMode: "hidden" as const,
    expandedThinking: [] as number[],
    width: 80,
    maxMessages: 200,
  };

  it("estimates more rows than the renderer draws for wide table rows", () => {
    const estimated = estimateViewportContentHeight(options);
    const actual = estimateViewportActualHeight(options);
    assert.ok(actual < estimated, `expected actual (${actual}) < estimated (${estimated})`);
  });

  it("matches the estimate when nothing is over-estimated", () => {
    const simple = { ...options, messages: [assistant("short line")] };
    assert.equal(
      estimateViewportActualHeight(simple),
      estimateViewportContentHeight(simple),
    );
  });

  it("clamps slice boxes to the drawn rows", () => {
    const viewport = selectMessageViewport({
      ...options,
      scrollOffset: 0,
      availableHeight: 40,
    });
    const item = viewport.items.find((candidate) => candidate.kind === "message");
    assert.ok(item && "actualHeight" in item);
    const clipped = item as { actualHeight: number; visibleHeight: number };
    assert.ok(clipped.actualHeight < clipped.visibleHeight);
    assert.ok(clipped.actualHeight >= 1);
  });

  it("keeps actual rows per truncated markdown kind at one", () => {
    assert.equal(countMarkdownRenderRows("```js\nx = 1\ny = 2\n```", 40), 4);
    assert.equal(countMarkdownRenderRows(table, 80), 3);
    // width - 4 body (paddingX 2 + marker 2): 120 / 36 still wraps to 4 rows.
    assert.equal(countMarkdownRenderRows("a".repeat(120), 40), 4);
  });
});

describe("streaming reasoning sizing", () => {
  const streamingBase = {
    messages: [] as ChatMessage[],
    streamingText: "",
    busy: true,
    expandedThinking: [] as number[],
    scrollOffset: 0,
    availableHeight: 40,
    width: 80,
  };

  it("counts a ≤3-line summary-mode streaming block as one collapsed row (F1)", () => {
    const reasoning = "step one\nstep two\nstep three";
    const viewport = selectMessageViewport({
      ...streamingBase,
      streamingReasoning: reasoning,
      thinkingMode: "summary",
    });
    const item = viewport.items.find((candidate) => candidate.kind === "streaming_reasoning");
    assert.ok(item && "visibleHeight" in item, "streaming_reasoning block missing");
    const block = item as { visibleHeight: number; actualHeight: number };
    // ThinkingBlock (isStreaming=busy) renders only the single `∴ Thinking ▸`
    // hint, and as the first live-stack row it adds its 1-row top margin.
    assert.equal(block.visibleHeight, 2);
    assert.equal(block.actualHeight, 2);
    assert.equal(estimateThinkingRows(reasoning, { mode: "summary", isStreaming: true, width: 80 }), 1);
  });

  it("keeps >3-line summary-mode streaming blocks collapsed like the render", () => {
    const reasoning = Array.from({ length: 5 }, (_, index) => `thought-${index}`).join("\n");
    const viewport = selectMessageViewport({
      ...streamingBase,
      streamingReasoning: reasoning,
      thinkingMode: "summary",
    });
    const item = viewport.items.find((candidate) => candidate.kind === "streaming_reasoning");
    assert.ok(item && "visibleHeight" in item);
    const block = item as { visibleHeight: number; actualHeight: number };
    // Streaming + summary without forceExpanded collapses regardless of
    // length (1 hint row) plus the live-stack top margin row.
    assert.equal(block.visibleHeight, 2);
    assert.equal(block.actualHeight, 2);
  });

  it("matches the expanded ThinkingBlock row count when the block is expanded", () => {
    // 35 lines in full mode: `∴ Thinking…` header + 30 capped body rows + truncation hint.
    const reasoning = Array.from({ length: 35 }, (_, index) => `thought-${index}`).join("\n");
    const viewport = selectMessageViewport({
      ...streamingBase,
      streamingReasoning: reasoning,
      thinkingMode: "full",
    });
    const item = viewport.items.find((candidate) => candidate.kind === "streaming_reasoning");
    assert.ok(item && "visibleHeight" in item);
    const block = item as { visibleHeight: number; actualHeight: number };
    // 1 live-stack top margin + 1 header + 30 capped body rows + truncation hint.
    assert.equal(block.visibleHeight, 1 + 1 + 30 + 1);
    assert.equal(block.actualHeight, 1 + 1 + 30 + 1);
    assert.equal(estimateThinkingRows(reasoning, { mode: "full", isStreaming: true, width: 80 }), 32);
    // forceExpanded summary path: header + 5 body rows.
    const short = Array.from({ length: 5 }, (_, index) => `thought-${index}`).join("\n");
    assert.equal(estimateThinkingRows(short, { mode: "summary", isStreaming: true, forceExpanded: true, width: 80 }), 6);
  });
});

describe("subagent_call sizing", () => {
  it("estimates and clamps subagent_call at subagentRenderLineCount + 1 marginTop row (F3)", () => {
    const msg: ChatMessage = {
      kind: "subagent_call",
      id: "sa-1",
      task: "summarize the docs",
      profile: "researcher",
      depth: 1,
      status: "done",
      innerEvents: [],
      toolCallCount: 0,
      startedAt: 0,
      expanded: false,
    };
    // Title row + `Done (…)` row under the SubagentCard marginTop={1} row.
    const expected = subagentRenderLineCount(msg, { width: 80 }) + 1;
    assert.equal(expected, 3);

    const viewport = selectMessageViewport({
      messages: [msg],
      streamingText: "",
      streamingReasoning: "",
      busy: false,
      thinkingMode: "hidden",
      expandedThinking: [],
      scrollOffset: 0,
      availableHeight: 20,
      width: 80,
    });
    const item = viewport.items.find((candidate) => candidate.kind === "message");
    assert.ok(item && "visibleHeight" in item);
    const block = item as { visibleHeight: number; actualHeight: number };
    assert.equal(block.visibleHeight, expected);
    assert.equal(block.actualHeight, expected);
    assert.equal(viewport.totalHeight, expected);
  });
});

describe("wrap width parity with the rendered feed", () => {
  it("wraps thinking and markdown bodies at width - 4, not width - 2 (F2)", () => {
    // 39 CJK characters = 78 terminal columns: they fit in the old width - 2
    // body (78 columns → 1 row) but wrap to 2 rows at the rendered width - 4
    // body (76 columns). This is the N → N+1 discriminator for the fix.
    const cjk = "中".repeat(39);
    // ThinkingBlock body: feed paddingX={1} (2 columns) + body paddingLeft={2}.
    assert.equal(estimateThinkingRows(cjk, { mode: "full", width: 80 }), 1 + 2);
    // Markdown body: feed paddingX (2 columns) + "⏺ " marker (2 columns).
    assert.equal(countMarkdownRenderRows(cjk, 80), 2);
  });

  it("keeps list rows inside the same width - 4 budget", () => {
    // "- " + 37 CJK (74 columns): rendered as "• " marker (2 columns incl.
    // gap) after the indent; 74 + 2 = 76 fits the width - 4 body exactly,
    // so the list row draws a single row. The pre-fix +3 gutter budget
    // over-estimated this to 2 rows and padded the frame with a blank band.
    assert.equal(countMarkdownRenderRows(`- ${"中".repeat(37)}`, 80), 1);
  });

  it("counts blank markdown lines as zero rows", () => {
    // Ink renders an empty <Text> as no rows at all (a column of "A",
    // <Text/>, "B" draws two rows), so blank lines inside a markdown body
    // must not reserve rows in the frame estimate.
    assert.equal(countMarkdownRenderRows("line one\n\nline two", 80), 2);
    assert.equal(countMarkdownRenderRows("\n\n", 80), 0);
    // Whitespace-only lines keep a real (non-empty) Text child, so Ink
    // draws one row for each — the estimate must count them as rows.
    assert.equal(countMarkdownRenderRows("  \n\n  ", 80), 2);
    // A list line with empty content still draws its marker row.
    assert.equal(countMarkdownRenderRows("- \n\n- item", 80), 2);
  });
});

describe("history block margins (uniform 1-row gaps)", () => {
  const base = {
    messages: [] as ChatMessage[],
    streamingText: "",
    streamingReasoning: "",
    busy: false,
    thinkingMode: "hidden" as const,
    expandedThinking: [] as number[],
    scrollOffset: 0,
    availableHeight: 40,
    width: 80,
  };

  it("counts a marginTop={1} row above tool_call blocks", () => {
    // done + no result: 1 margin + 1 title row.
    const done: ChatMessage = { kind: "tool_call", id: "t1", name: "read", args: "", rawArgs: {}, status: "done", startedAt: 0 };
    let viewport = selectMessageViewport({ ...base, messages: [done] });
    let block = viewport.items.find((item) => item.kind === "message") as { visibleHeight: number } | undefined;
    assert.equal(block?.visibleHeight, 2);
    assert.equal(viewport.totalHeight, 2);

    // running adds the Working… row: 1 margin + 1 title + 1 status row.
    const running: ChatMessage = { ...done, status: "running" };
    viewport = selectMessageViewport({ ...base, messages: [running] });
    block = viewport.items.find((item) => item.kind === "message") as { visibleHeight: number } | undefined;
    assert.equal(block?.visibleHeight, 3);
  });

  it("counts a marginTop={1} row above notice and error blocks", () => {
    const notice: ChatMessage = { kind: "notice", text: "session resumed" };
    let viewport = selectMessageViewport({ ...base, messages: [notice] });
    assert.equal(viewport.totalHeight, 2);

    const titled: ChatMessage = { kind: "notice", title: "Validation", text: "ok" };
    viewport = selectMessageViewport({ ...base, messages: [titled] });
    assert.equal(viewport.totalHeight, 3);

    const error: ChatMessage = { kind: "error", text: "boom" };
    viewport = selectMessageViewport({ ...base, messages: [error] });
    assert.equal(viewport.totalHeight, 2);
  });

  it("keeps the live stack top margin at exactly one row", () => {
    // reasoning + text + busy: only the first live row (reasoning) carries
    // the 1-row gap; text/busy follow with 0.
    const viewport = selectMessageViewport({
      ...base,
      busy: true,
      thinkingMode: "summary",
      streamingText: "hello",
      streamingReasoning: "think",
    });
    // reasoning collapsed (1) + margin (1) = 2; text = 1; busy = 1 → 4.
    assert.equal(viewport.totalHeight, 2 + 1 + 1);

    // busy alone: the busy row IS the live top → 1 margin + 1 row = 2.
    const busyOnly = selectMessageViewport({ ...base, busy: true });
    assert.equal(busyOnly.totalHeight, 2);
  });
});
