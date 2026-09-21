import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toolDisplayName, toolResultPrefix, toolStatusIcon, toolSummary } from "../src/tui/tool-lines.ts";

describe("TUI tool render model", () => {
  it("normalizes tool names and status icons", () => {
    assert.equal(toolDisplayName("  read  "), "read");
    assert.equal(toolDisplayName(""), "tool");
    assert.equal(toolStatusIcon("running"), "…");
    assert.equal(toolStatusIcon("done"), "✓");
    assert.equal(toolStatusIcon("error"), "✗");
  });

  it("formats a stable tool summary", () => {
    assert.equal(toolSummary("bash", "done", 12), "✓ bash (12ms)");
    assert.equal(toolSummary("read", "running"), "… read");
  });

  it("keeps multi-line tool results on a connected tree gutter", () => {
    assert.deepEqual(
      [0, 1, 2].map((index) => toolResultPrefix(index, 3)),
      ["  ├─ ", "  │  ", "  └─ "],
    );
    assert.equal(toolResultPrefix(0, 1), "  └─ ");
  });
});
