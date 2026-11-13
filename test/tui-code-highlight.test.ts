import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { codeTokenAttrs, codeTokenColor, highlightCodeLine } from "../src/tui/code-highlight.ts";
import { resetTheme, applyTheme } from "../src/tui/theme.ts";
import { messagePhysicalRows } from "../src/tui/message-rows.ts";

const spanText = (spans: { text: string }[]) => spans.map((s) => s.text).join("");

describe("highlightCodeLine tokenizer", () => {
  it("classifies js keywords, strings, numbers, comments and calls", () => {
    const spans = highlightCodeLine('const x = parse("abc", 42); // note', "ts");
    assert.equal(spanText(spans), 'const x = parse("abc", 42); // note', "spans cover the line exactly");
    assert.equal(spans[0]!.kind, "keyword");
    assert.ok(spans.some((s) => s.text === "parse" && s.kind === "function"));
    assert.ok(spans.some((s) => s.text === '"abc"' && s.kind === "string"));
    assert.ok(spans.some((s) => s.text === "42" && s.kind === "number"));
    assert.ok(spans.some((s) => s.text.startsWith("// note") && s.kind === "comment"));
  });

  it("handles python def/class and triple-ish strings per line", () => {
    const spans = highlightCodeLine("def load(path):  # read file", "python");
    assert.equal(spanText(spans), "def load(path):  # read file");
    assert.equal(spans[0]!.kind, "keyword");
    assert.ok(spans.some((s) => s.text === "load" && s.kind === "function"));
    assert.ok(spans.some((s) => s.kind === "comment"));
  });

  it("handles shell variables and comments", () => {
    const spans = highlightCodeLine("echo \"$HOME/${TMPDIR}d\" # list", "bash");
    assert.equal(spanText(spans), 'echo "$HOME/${TMPDIR}d" # list');
    assert.ok(spans.some((s) => s.kind === "string"));
    assert.ok(spans.some((s) => s.kind === "comment"));
  });

  it("marks json keys as properties and values as strings", () => {
    const spans = highlightCodeLine('  "count": 3,', "json");
    assert.ok(spans.some((s) => s.text === '"count"' && s.kind === "property"));
    assert.ok(spans.some((s) => s.text === "3" && s.kind === "number"));
  });

  it("falls back to plain coverage for unknown languages", () => {
    const spans = highlightCodeLine("select * from t", "sql");
    assert.equal(spanText(spans), "select * from t");
    assert.ok(spans.every((s) => s.kind === "plain" || s.kind === "operator" || s.kind === "function"));
  });

  it("always preserves the exact source text", () => {
    for (const line of ['', 'a = "unclosed', "x = y.z(1)", "#!/bin/env bash", "a ?? b !== c"]) {
      assert.equal(spanText(highlightCodeLine(line, "js")), line, `roundtrip for ${line}`);
    }
  });
});

describe("token colors follow the live theme", () => {
  afterEach(() => resetTheme());

  it("resolves palette slots at call time", () => {
    resetTheme();
    assert.equal(codeTokenColor("keyword"), "#b1b9f9");
    applyTheme("solarized-dark");
    assert.equal(codeTokenColor("keyword"), "#268bd2", "LightBlue of solarized");
    assert.equal(codeTokenColor("string"), "#d0b000");
    assert.deepEqual(codeTokenAttrs("comment"), { dim: true, italic: true });
  });
});

describe("fenced code rows carry spans", () => {
  afterEach(() => resetTheme());

  const build = (text: string) => messagePhysicalRows(
    { kind: "assistant", text } as never,
    0,
    { width: 60, thinkingMode: "summary", expanded: false, focused: false },
  );

  it("code lines get gutter + token spans whose text equals the row text", () => {
    const rows = build('```ts\nconst a = 1;\n```');
    const codeRow = rows.find((row) => row.text.includes("const a"));
    assert.ok(codeRow?.spans?.length, "spans present");
    assert.equal(codeRow.spans!.map((s) => s.text).join(""), codeRow.text);
    assert.equal(codeRow.spans![0]!.kind, "gutter");
    assert.ok(codeRow.spans!.some((s) => s.kind === "keyword"));
  });

  it("streaming projections keep committed rows stable while the last line grows", () => {
    const full = build('```python\ndef f():\n    return 1\n```');
    const partial = build('```python\ndef f():\n    ret');
    const fullCode = full.filter((r) => r.spans).map((r) => r.text);
    const partialCode = partial.filter((r) => r.spans).map((r) => r.text);
    assert.deepEqual(
      partialCode.slice(0, -1),
      fullCode.slice(0, partialCode.length - 1),
      "everything before the growing tail line is identical",
    );
    assert.ok(partialCode.at(-1)!.startsWith("▌     ret"), "tail line carries the growing text");
  });
});
