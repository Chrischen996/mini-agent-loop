import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IncrementalTerminalRenderer } from "../src/tui/incremental-renderer.ts";
import { graphemeWidth, terminalStringWidth, truncateTerminalText, wrapTerminalLine } from "../src/tui/terminal-width.ts";
import { messagePhysicalRows } from "../src/tui/message-rows.ts";
import { estimateMessageHeight, selectMessageViewport, MessageHeightCache } from "../src/tui/message-viewport.ts";
import type { ChatMessage } from "../src/tui/state.ts";

function sink(rows: number, columns: number) {
  const writes: string[] = [];
  const target = {
    columns,
    rows,
    write(value: string) {
      writes.push(value);
      return true;
    },
  };
  return { writes, target };
}

describe("incremental renderer screen bounds", () => {
  it("paints bottom-anchored rows when the frame exceeds terminal height", () => {
    const output = sink(3, 40);
    const renderer = new IncrementalTerminalRenderer(output.target as never);
    renderer.renderRows(["a", "b", "c", "d", "e"]);
    const painted = output.writes.join("");
    // Only the last three logical rows exist on screen.
    assert.match(painted, /\x1b\[1;1H\x1b\[2Kc/);
    assert.match(painted, /\x1b\[2;1H\x1b\[2Kd/);
    assert.match(painted, /\x1b\[3;1H\x1b\[2Ke/);
    assert.ok(!painted.includes("\x1b[4;1H"), "never address rows below the viewport");
  });

  it("clears stale rows when the next frame is shorter", () => {
    const output = sink(5, 40);
    const renderer = new IncrementalTerminalRenderer(output.target as never);
    renderer.renderRows(["a", "b", "c", "d"]);
    output.writes.length = 0;
    renderer.renderRows(["a"]);
    const painted = output.writes.join("");
    assert.match(painted, /\x1b\[2;1H\x1b\[2K/);
    assert.match(painted, /\x1b\[4;1H\x1b\[2K/);
  });

  it("repaints the frame after a terminal resize", () => {
    const output = sink(4, 40);
    const renderer = new IncrementalTerminalRenderer(output.target as never);
    renderer.renderRows(["one", "two"]);
    output.writes.length = 0;
    renderer.renderRows(["one", "two"]);
    assert.equal(output.writes.join(""), "", "identical frame at the same size repaints nothing");
    renderer.renderRows(["one", "two"], true);
    assert.match(output.writes.join(""), /one/);
  });

  it("drops control characters from painted rows", () => {
    const output = sink(3, 40);
    const renderer = new IncrementalTerminalRenderer(output.target as never);
    renderer.renderRows(["ok\u0007bell\u001b[<64;1;1M"]);
    const painted = output.writes.join("");
    assert.ok(!painted.includes("\u0007"));
    assert.ok(!painted.includes("\x1b[<64"));
  });
});

describe("terminal width helpers", () => {
  it("counts CJK as double width and combining marks as zero", () => {
    assert.equal(terminalStringWidth("中文"), 4);
    assert.equal(terminalStringWidth("e\u0301"), 1);
  });

  it("keeps emoji families on one row", () => {
    assert.equal(terminalStringWidth("😀"), 2);
    const family = "👨‍👩‍👧‍👦";
    assert.ok(terminalStringWidth(family) <= 8);
    assert.equal(graphemeWidth(family), terminalStringWidth(family));
  });

  it("wraps by grapheme without splitting a cluster", () => {
    const rows = wrapTerminalLine("ab😀cd", 4);
    assert.equal(rows.join("|"), "ab😀|cd");
  });

  it("wraps with a first-row gutter and hanging indent", () => {
    const rows = wrapTerminalLine("一二三四五六", 6, { firstColumn: 2, continuationColumn: 2 });
    assert.equal(rows[0], "一二");
    assert.ok(rows.every((row) => terminalStringWidth(row) <= 6));
  });

  it("truncates over-wide text to the column budget", () => {
    const truncated = truncateTerminalText("一二三四五", 7);
    assert.ok(terminalStringWidth(truncated) <= 7);
    assert.ok(truncated.endsWith("…"));
  });
});

describe("physical row projection", () => {
  const width = 40;

  it("estimates assistant height from the same rows the feed renders", () => {
    const message: ChatMessage = {
      kind: "assistant",
      text: "# 标题\n\n一二三四五六七八九十十一十二十三十四十五十六十七十八十九廿%",
    };
    const rows = messagePhysicalRows(message, 0, { width, thinkingMode: "summary", expanded: false, focused: false });
    assert.equal(rows.length, estimateMessageHeight(message, { width, thinkingMode: "summary", expandedThinking: new Set(), index: 0 }));
    for (const row of rows) {
      assert.ok(terminalStringWidth(row.text) <= width - 2, `row too wide: ${JSON.stringify(row.text)}`);
    }
  });

  it("counts wrapped CJK lines exactly like the terminal", () => {
    const long = "汉".repeat(60);
    const message: ChatMessage = { kind: "assistant", text: long };
    const rows = messagePhysicalRows(message, 0, { width, thinkingMode: "summary", expanded: false, focused: false });
    // 120 cells at width-4 = 36 columns/row → 4 rows (with the 1 gap row).
    assert.equal(rows.length, 1 + Math.ceil(120 / 36));
  });

  it("viewport slices never exceed the available height", () => {
    const messages: ChatMessage[] = Array.from({ length: 8 }, (_, index): ChatMessage => ({
      kind: "assistant",
      text: `消息 ${index} ${"内容".repeat(30)}`,
    }));
    const selection = selectMessageViewport({
      messages,
      streamingText: "",
      streamingReasoning: "",
      busy: false,
      thinkingMode: "summary",
      expandedThinking: [],
      scrollOffset: 6,
      availableHeight: 10,
      width,
    });
    let drawn = 0;
    for (const item of selection.items) {
      if (item.kind === "history_hint") drawn += 1;
      else drawn += item.rows.length;
    }
    assert.ok(drawn <= 10, `viewport drew ${drawn} rows for a 10-row budget`);
  });

  it("caches per-message rows and invalidates on width change", () => {
    const cache = new MessageHeightCache();
    const message: ChatMessage = { kind: "assistant", text: "hello world" };
    const first = cache.get(message, 0, { width, thinkingMode: "summary", expanded: false });
    const again = cache.get(message, 0, { width, thinkingMode: "summary", expanded: false });
    assert.equal(first.rows, again.rows);
    const wider = cache.get(message, 0, { width: 120, thinkingMode: "summary", expanded: false });
    assert.ok(wider.rows.length <= first.rows.length);
  });
});

