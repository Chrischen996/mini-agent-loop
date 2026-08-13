import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLegacyFrameOutput, buildLegacyFrameRowCount } from "../src/tui/legacy-render.ts";
import { getMessageFeedHeight, getPickerLayout, getTuiViewportHeight } from "../src/tui/layout.ts";

describe("legacy TUI renderer", () => {
  it("updates frames without clearing the entire terminal", () => {
    const output = buildLegacyFrameOutput(["header", "thinking"], 2);
    assert.equal(output.includes("\x1b[2J"), false);
    assert.equal(output.startsWith("\x1b[H"), true);
    assert.equal(output.includes("\x1b[2Kheader"), true);
  });

  it("clears rows left by a longer previous frame", () => {
    const output = buildLegacyFrameOutput(["header"], 3);
    assert.equal(output.includes("\x1b[2K"), true);
    assert.equal(output.includes("\x1b[2;1H\x1b[2K"), true);
    assert.equal(output.includes("\x1b[3;1H\x1b[2K"), true);
  });

  it("counts wrapped and wide-character rows", () => {
    assert.equal(buildLegacyFrameRowCount(["123456789"], 5), 2);
    assert.equal(buildLegacyFrameRowCount(["中文中文"], 4), 2);
    const output = buildLegacyFrameOutput(["123456789"], 4, 5);
    assert.equal(output.includes("\x1b[3;1H\x1b[2K"), true);
    assert.equal(output.includes("\x1b[4;1H\x1b[2K"), true);
  });
});

describe("Ink TUI viewport", () => {
  it("always leaves one terminal row available for Ink's cursor protocol", () => {
    assert.equal(getTuiViewportHeight(24), 23);
    assert.equal(getTuiViewportHeight(1), 1);
    assert.equal(getTuiViewportHeight(undefined), 23);
  });

  it("reserves chrome rows for the message feed", () => {
    assert.ok(getMessageFeedHeight({ termRows: 24 }) < getTuiViewportHeight(24));
    assert.ok(getMessageFeedHeight({ termRows: 24 }) >= 3);
    assert.ok(
      getMessageFeedHeight({ termRows: 24, hasPendingImages: true, pickerRows: 6 })
        < getMessageFeedHeight({ termRows: 24 }),
    );
  });

  it("bounds picker rows while preserving a minimum message feed", () => {
    const picker = getPickerLayout({ termRows: 20, requestedItems: 12, extraRows: 3 });
    assert.ok(picker.itemRows < 12);
    assert.equal(picker.totalRows, picker.itemRows + 3);
    assert.ok(getMessageFeedHeight({ termRows: 20, pickerRows: picker.totalRows }) >= 3);
  });
});
