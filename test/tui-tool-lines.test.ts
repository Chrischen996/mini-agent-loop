import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toolDisplayName, toolStatusIcon, toolSummary, toolVisualName } from "../src/tui/tool-lines.ts";
import { RESULT_GUTTER } from "../src/tui/render-lines.ts";

describe("TUI tool render model", () => {
  it("normalizes tool names and status icons", () => {
    assert.equal(toolDisplayName("  read  "), "read");
    assert.equal(toolDisplayName(""), "tool");
    assert.equal(toolStatusIcon("running"), "⟳");
    assert.equal(toolStatusIcon("done"), "✓");
    assert.equal(toolStatusIcon("partial"), "~");
    assert.equal(toolStatusIcon("error"), "✗");
    assert.equal(toolVisualName("git_diff"), "GitDiff");
    assert.equal(toolVisualName("read"), "Read");
    assert.equal(toolVisualName("custom_tool"), "custom_tool");
  });

  it("formats a stable tool summary", () => {
    assert.equal(toolSummary("bash", "done", 12), "✓ bash (12ms)");
    assert.equal(toolSummary("read", "running"), "⟳ read");
  });

  it("keeps multi-line tool results on a connected tree gutter", () => {
    assert.equal(RESULT_GUTTER, "  ⎿ ");
  });
});
