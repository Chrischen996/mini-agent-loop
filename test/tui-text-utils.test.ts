import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactText } from "../src/tui/text-utils.ts";

describe("compactText", () => {
  it("normalizes whitespace and preserves the legacy suffix contract", () => {
    assert.equal(compactText("  one\n two  ", 20), "one two");
    assert.equal(compactText("abcdefghijklmnopqrstuvwxyz", 5), "abcde...");
  });

  it("can include the ellipsis in the maximum width", () => {
    assert.equal(compactText("abcdefghijklmnopqrstuvwxyz", 5, "…", { maxIncludesEllipsis: true }), "abcd…");
  });
});
