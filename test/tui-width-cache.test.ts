import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearTerminalWidthCaches,
  graphemeWidth,
  terminalStringWidth,
} from "../src/tui/terminal-width.ts";

describe("terminal width caches", () => {
  it("returns stable widths across warm and cold caches", () => {
    clearTerminalWidthCaches();
    assert.equal(terminalStringWidth("中文"), 4);
    assert.equal(terminalStringWidth("中文"), 4, "cached repeat");
    assert.equal(graphemeWidth("😀"), 2);
    assert.equal(graphemeWidth("😀"), 2, "cached repeat");
    assert.equal(terminalStringWidth("e\u0301"), 1, "combining marks count once");
    clearTerminalWidthCaches();
    assert.equal(terminalStringWidth("中文"), 4, "cold recompute after clear");
    // ZWJ families: the first member is 2 columns, each joined member adds 1.
    const family = "👨\u200d👩\u200d👧\u200d👦";
    assert.equal(graphemeWidth(family), 5);
    assert.equal(graphemeWidth(family), terminalStringWidth(family));
  });

  it("ignores ANSI styling in cached line widths", () => {
    clearTerminalWidthCaches();
    assert.equal(terminalStringWidth("\u001b[1mabc\u001b[22m"), 3);
    assert.equal(terminalStringWidth("\u001b[1mabc\u001b[22m"), 3, "styled repeat");
    assert.equal(terminalStringWidth("abc"), 3);
  });

  it("keeps styled and plain variants as distinct cache entries", () => {
    clearTerminalWidthCaches();
    const styled = terminalStringWidth("\u001b[38;5;231m你\u001b[39m");
    const plain = terminalStringWidth("你");
    assert.equal(styled, 2);
    assert.equal(plain, 2);
  });
});
