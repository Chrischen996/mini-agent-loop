import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeCommitBoundary, rowCountledCommitted, rowTexts, collectResizeRefreshRows } from "../src/tui/stream-commit.ts";
import { selectMessageViewport, streamingAssistantRows } from "../src/tui/message-viewport.ts";
import { IncrementalTerminalRenderer } from "../src/tui/incremental-renderer.ts";
import { resolveTuiLayoutMode } from "../src/tui/layout-mode.ts";
import { headerStaticText } from "../src/tui/components/Header.tsx";

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
  it("commits completed lines and holds the growing last line", () => {
    assert.equal(computeCommitBoundary(""), 0);
    assert.equal(computeCommitBoundary("Hello wor"), 0);
    assert.equal(computeCommitBoundary("Hello world\nsecond paragraph grow"), "Hello world\n".length);
  });

  it("commits every closed line up to the unterminated tail", () => {
    const text = "para one\nstill one\n\npara two ta";
    assert.equal(computeCommitBoundary(text), "para one\nstill one\n\n".length);
  });

  it("commits fenced code lines as they complete (stable gutter rows)", () => {
    const text = "intro\n\n```\nconst x = 1\n";
    assert.equal(computeCommitBoundary(text), text.length);
  });

  it("commits blank lines inside a fence", () => {
    const text = "```\n\nstill code\n";
    assert.equal(computeCommitBoundary(text), text.length);
  });

  it("holds back an open table until a following line closes it", () => {
    const held = "| a | b |\n| - | - |\n| 1 | 2 |\n";
    assert.equal(computeCommitBoundary(held), 0);
    const closedByBlank = "| a | b |\n| - | - |\n| 1 | 2 |\n\nafter\n";
    assert.equal(computeCommitBoundary(closedByBlank), closedByBlank.length);
    const closedByLine = "| a | b |\n| - | - |\n| 1 | 2 |\nplain tail";
    assert.equal(computeCommitBoundary(closedByLine), "| a | b |\n| - | - |\n| 1 | 2 |\n".length);
  });

  it("does not mistake pipe lines inside a fence for a table", () => {
    const text = "```\n| not | a table |\n```\n";
    assert.equal(computeCommitBoundary(text), text.length);
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
  it("accepts document aliases and keeps document the default", () => {
    assert.equal(resolveTuiLayoutMode({}), "document");
    for (const raw of ["document", "doc", "flow", "INSERT"]) {
      assert.equal(resolveTuiLayoutMode({ MINI_AGENT_TUI_LAYOUT: raw }), "document");
    }
    assert.equal(resolveTuiLayoutMode({ MINI_AGENT_TUI_LAYOUT: "alt" }), "alternate");
    assert.equal(resolveTuiLayoutMode({ MINI_AGENT_TUI_LAYOUT: "inline" }), "inline");
  });

describe("headerStaticText (document layout header burst)", () => {
  it("renders one ANSI line with brand, model and cwd", () => {
    const line = headerStaticText({ width: 80, modelName: "gpt-test", cwd: "/tmp/proj" });
    assert.ok(!line.includes("\n"), "single line");
    assert.ok(line.includes("mini-agent"));
    assert.ok(line.includes("gpt-test"));
    assert.ok(line.includes("/tmp/proj"));
    assert.ok(line.startsWith("\x1b[1;38;2;"), "bold brand segment opens with SGR");
    assert.ok(line.endsWith("\x1b[0m"), "self-contained reset");
  });

  it("omits missing model/cwd segments", () => {
    const line = headerStaticText({ width: 80 });
    assert.equal(line.split("\x1b[").length - 1, 2, "one segment: open + reset");

describe("collectResizeRefreshRows (gemini-style resize refresh)", () => {
  const rows = (prefix: string, n: number, textLen = 40) =>
    Array.from({ length: n }, (_, i) => ({ text: `${prefix}${i}x`.padEnd(textLen, "x") }));

  it("returns nothing for empty items", () => {
    assert.deepEqual(collectResizeRefreshRows([], { minRows: 10 }), []);
  });

  it("covers at least one screen even when the char budget is small", () => {
    const items = [{ rows: rows("r", 30) }];
    const window = collectResizeRefreshRows(items, { minRows: 10, maxChars: 10 });
    assert.ok(window.length >= 10, "one screen minimum wins over the budget");
  });

  it("keeps accumulating past one screen with short rows until the char budget", () => {
    const items = [{ rows: rows("s", 50, 5) }];
    const window = collectResizeRefreshRows(items, { minRows: 5, maxChars: 100 });
    assert.ok(window.length >= 20, "short rows need more lines to hit the budget");
    assert.ok(window.length < 50, "and it stops before the full history");
  });

  it("returns chronological order across items", () => {
    const items = [{ rows: rows("a", 2) }, { rows: rows("b", 2) }, { rows: rows("c", 2) }];
    const window = collectResizeRefreshRows(items, { minRows: 6, maxChars: 100_000 });
    assert.deepEqual(window.map((row) => row.text[0]), ["a", "a", "b", "b", "c", "c"]);
  });

  it("includes the newest item fully before any budget stop", () => {
    const items = [{ rows: rows("o", 3) }, { rows: rows("n", 40, 60) }];
    const window = collectResizeRefreshRows(items, { minRows: 5, maxChars: 100 });
    assert.equal(window[window.length - 1]!.text[0], "n");
    assert.ok(window.filter((row) => row.text[0] === "n").length >= 5);
  });
});

  });
});

});

