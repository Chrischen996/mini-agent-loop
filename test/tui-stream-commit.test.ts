import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeCommitBoundary, rowCountledCommitted, rowTexts } from "../src/tui/stream-commit.ts";
import { selectMessageViewport, streamingAssistantRows } from "../src/tui/message-viewport.ts";
import { IncrementalTerminalRenderer } from "../src/tui/incremental-renderer.ts";
import { resolveTuiLayoutMode } from "../src/tui/layout-mode.ts";

function sizedSink(rows: number, columns = 40) {
  const writes: string[] = [];
  const target = {
    rows,
    columns,
    write(value: string) {
      writes.push(value);
      return true;
    },
  };
  return { writes, target };
}

describe("computeCommitBoundary (document layout stream commits)", () => {
  it("commits nothing until a paragraph closes", () => {
    assert.equal(computeCommitBoundary(""), 0);
    assert.equal(computeCommitBoundary("Hello wor"), 0);
    assert.equal(computeCommitBoundary("Hello world\nsecond paragraph grow"), 0);
  });

  it("commits up to and including the last closing blank line", () => {
    const text = "para one\nstill one\n\npara two ta";
    const boundary = computeCommitBoundary(text);
    assert.equal(text.slice(0, boundary), "para one\nstill one\n\n");
  });

  it("holds back an open code fence", () => {
    const text = "intro\n\n```\nconst x = 1\n";
    const boundary = computeCommitBoundary(text);
    assert.equal(text.slice(0, boundary), "intro\n\n");
  });

  it("does not commit blank lines inside a fence", () => {
    const text = "```\n\nstill code\n";
    assert.equal(computeCommitBoundary(text), 0);
  });

  it("commits the fence once it closes and the next paragraph breaks", () => {
    const text = "```\ncode\n```\n\nnext\n";
    assert.equal(computeCommitBoundary(text), text.length - "next\n".length);
  });

  it("holds back a table until the blank line closes it", () => {
    const held = "| a | b |\n| - | - |\n| 1 | 2 |\n";
    assert.equal(computeCommitBoundary(held), 0);
    const closed = "| a | b |\n| - | - |\n| 1 | 2 |\n\nafter\n";
    assert.equal(computeCommitBoundary(closed), "| a | b |\n| - | - |\n| 1 | 2 |\n\n".length);
  });
});

describe("rowCountledCommitted (seal dedup)", () => {
  it("finds the longest common row prefix", () => {
    assert.equal(rowCountledCommitted(["a", "b", "c"], ["a", "b"]), 2);
    assert.equal(rowCountledCommitted(["a", "b"], ["x", "b", "a"]), 0);
    assert.equal(rowCountledCommitted([], ["a"]), 0);
  });
});

describe("streamingAssistantRows projection", () => {
  it("is prefix-stable: rows for a committed prefix are a prefix of the full rows", () => {
    const full = "First paragraph line that wraps around the feed width to prove wrapping\n\nSecond paragraph still growing he";
    const boundary = computeCommitBoundary(full);
    const width = 40;
    const prefix = streamingAssistantRows(full.slice(0, boundary), { width, thinkingMode: "hidden" });
    const all = streamingAssistantRows(full, { width, thinkingMode: "hidden" });
    const prefixTexts = rowTexts(prefix);
    assert.deepEqual(rowTexts(all).slice(0, prefixTexts.length), prefixTexts);
  });
});

describe("document layout viewport (committed streaming rows)", () => {
  const streamingText = "Alpha paragraph.\n\nBeta paragraph tail";

  it("live text block renders the full-markdown projection minus committed rows", () => {
    const width = 40;
    const all = streamingAssistantRows(streamingText, { width, thinkingMode: "hidden" });
    const committed = streamingAssistantRows(
      streamingText.slice(0, computeCommitBoundary(streamingText)),
      { width, thinkingMode: "hidden" },
    );
    const viewport = selectMessageViewport({
      messages: [],
      streamingText,
      streamingReasoning: "",
      busy: false,
      thinkingMode: "hidden",
      expandedThinking: [],
      scrollOffset: 0,
      availableHeight: 30,
      width,
      documentMode: true,
      committedStreamingRows: committed.length,
    });
    const textItem = viewport.items.find((item) => item.kind === "streaming_text");
    assert.ok(textItem && textItem.kind === "streaming_text");
    assert.deepEqual(rowTexts(textItem.rows), rowTexts(all.slice(committed.length)));
    assert.ok(textItem.rows.length < all.length, "committed rows are dropped from the frame");
  });

  it("non-document mode keeps the compact streaming preview", () => {
    const viewport = selectMessageViewport({
      messages: [],
      streamingText,
      streamingReasoning: "",
      busy: true,
      thinkingMode: "hidden",
      expandedThinking: [],
      scrollOffset: 0,
      availableHeight: 30,
      width: 40,
    });
    const textItem = viewport.items.find((item) => item.kind === "streaming_text");
    assert.ok(textItem && textItem.kind === "streaming_text");
    assert.ok(textItem.rows.some((row) => row.key.startsWith("streaming-text-")), "legacy preview keys");
  });
});

describe("document layout renderer (anchor pipeline)", () => {
  it("shares the inline anchor pipeline: erase, burst, repaint below", () => {
    const output = sizedSink(10);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "document" });
    renderer.write("a\nb\nc");
    output.writes.length = 0;

    renderer.emitStaticBurst("hello\n");
    const painted = output.writes.join("");
    assert.ok(painted.includes("\x1b[8;1Hhello\n"), "burst written raw at the anchor");
    assert.match(painted, /\x1b\[8;1H\x1b\[2Ka/);
    assert.match(painted, /\x1b\[10;1H\x1b\[2Kc/);
  });
});

describe("resolveTuiLayoutMode", () => {
  it("accepts document aliases and keeps inline the default", () => {
    assert.equal(resolveTuiLayoutMode({}), "inline");
    for (const raw of ["document", "doc", "flow", "INSERT"]) {
      assert.equal(resolveTuiLayoutMode({ MINI_AGENT_TUI_LAYOUT: raw }), "document");
    }
    assert.equal(resolveTuiLayoutMode({ MINI_AGENT_TUI_LAYOUT: "alt" }), "alternate");
  });
});

