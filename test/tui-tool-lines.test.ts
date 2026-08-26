import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toolDisplayName, toolStatusIcon, toolSummary } from "../src/tui/tool-lines.ts";

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
});

