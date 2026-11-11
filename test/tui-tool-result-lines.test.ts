import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildToolResultRows, isDiffResult, toolResultRowText, TOOL_RESULT_MAX_LINES } from "../src/tui/tool-result-lines.ts";
import { RESULT_GUTTER } from "../src/tui/render-lines.ts";
import { buildTerminalRenderLines } from "../src/tui/terminal-render-model.ts";
import { transcriptRows } from "../src/tui/transcript-lines.ts";
import { createInitialState, tuiReducer } from "../src/tui/state.ts";

const UNIFIED_DIFF = [
  "diff --git a/src/loop.ts b/src/loop.ts",
  "--- a/src/loop.ts",
  "+++ b/src/loop.ts",
  "@@ -812,2 +812,6 @@",
  "-  const reply = await streamOnce(history);",
  "+  const reply = await withRetry(streamOnce, policy);",
  "   history.push(reply);",
].join("\n");

describe("shared tool result rows", () => {
  it("detects a unified diff by its hunk header", () => {
    assert.equal(isDiffResult(UNIFIED_DIFF), true);
    assert.equal(isDiffResult("line one\nline two"), false);
    assert.equal(isDiffResult("+ not a diff without a hunk"), false);
  });

  it("tones +/- diff lines and keeps context dim", () => {
    const rows = buildToolResultRows(UNIFIED_DIFF);
    assert.equal(rows.find((row) => row.text.startsWith("-  const reply"))?.tone, "error");
    assert.equal(rows.find((row) => row.text.startsWith("+  const reply"))?.tone, "success");
    assert.equal(rows.find((row) => row.text.startsWith("   history"))?.dim, true);
    assert.equal(rows.find((row) => row.text.startsWith("@@"))?.dim, true);
  });

  it("keeps plain output dim and reports overflow", () => {
    const source = Array.from({ length: TOOL_RESULT_MAX_LINES + 4 }, (_, index) => `line ${index}`).join("\n");
    const rows = buildToolResultRows(source);
    assert.equal(rows.length, TOOL_RESULT_MAX_LINES + 1);
    assert.ok(rows.every((row) => row.dim && row.tone === undefined));
    assert.match(rows.at(-1)!.text, /4 more lines/);
  });

  it("projects identical result text into ANSI rows and scrollback rows", () => {
    const call = { id: "tool-1", name: "git_diff", arguments: {} };
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "LOOP_EVENT", event: { type: "tool_start", call } });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "tool_end", call, result: { content: UNIFIED_DIFF, isError: false } },
    });

    const ansiRows = buildTerminalRenderLines(state)
      .filter((line) => line.key.includes("message-0-result"))
      .map((line) => `${line.prefix ?? ""}${line.text}`);
    const sharedRows = buildToolResultRows(UNIFIED_DIFF).map(toolResultRowText);
    assert.deepEqual(ansiRows, sharedRows);

    const scrollback = transcriptRows({ messages: state.messages, width: 100, height: 100 })
      .map((row) => row.text);
    for (const row of sharedRows) assert.ok(scrollback.includes(row), `scrollback missing ${row}`);

    const diffTones = buildTerminalRenderLines(state)
      .filter((line) => line.key.includes("message-0-result"))
      .map((line) => line.tone);
    assert.ok(diffTones.includes("success"));
    assert.ok(diffTones.includes("error"));
  });

  it("uses one shared gutter constant", () => {
    assert.equal(RESULT_GUTTER, "  ⎿ ");
    assert.equal(toolResultRowText({ text: "ok", dim: true }), "  ⎿ ok");
  });
});
