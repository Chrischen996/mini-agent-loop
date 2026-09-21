import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactStreamingText, compactText } from "../src/tui/text-utils.ts";

describe("compactStreamingText", () => {
  it("keeps the live stream bounded while preserving the newest lines", () => {
    const source = Array.from({ length: 14 }, (_, index) => `line-${index + 1}`).join("\n");
    assert.equal(compactStreamingText(source, 3), "… 11 earlier lines\nline-12\nline-13\nline-14");
  });

  it("does not alter short streams", () => {
    assert.equal(compactStreamingText("one\ntwo", 3), "one\ntwo");
  });
});

describe("compactText", () => {
  it("normalizes whitespace and preserves the legacy suffix contract", () => {
    assert.equal(compactText("  one\n two  ", 20), "one two");
    assert.equal(compactText("abcdefghijklmnopqrstuvwxyz", 5), "abcde...");
  });

  it("can include the ellipsis in the maximum width", () => {
    assert.equal(compactText("abcdefghijklmnopqrstuvwxyz", 5, "…", { maxIncludesEllipsis: true }), "abcd…");
  });
});
