import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { workbenchColumns } from "../apps/web/src/lib/layout.ts";

describe("web workbench responsive columns", () => {
  it("keeps an unopened dock out of the chat area", () => {
    assert.deepEqual(workbenchColumns(1440, 280, 0), { left: 280, right: 0, overlay: false });
  });
  it("shrinks the dock before squeezing chat below 400px", () => {
    assert.deepEqual(workbenchColumns(1100, 280, 495), { left: 280, right: 420, overlay: false });
  });
  it("uses an overlay when there is no room for a 300px dock", () => {
    assert.deepEqual(workbenchColumns(800, 280, 360), { left: 280, right: 0, overlay: true });
  });
  it("keeps navigation in a 56px rail on small screens", () => {
    assert.deepEqual(workbenchColumns(390, 0, 300), { left: 56, right: 0, overlay: true });
  });
  it("clamps dragged sidebar and dock widths", () => {
    assert.deepEqual(workbenchColumns(1600, 999, 9999), { left: 420, right: 780, overlay: false });
    assert.equal(workbenchColumns(1600, 1, 0).left, 264);
  });
});
