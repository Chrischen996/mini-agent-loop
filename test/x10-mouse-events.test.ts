import assert from "node:assert/strict";
import test from "node:test";
import {
  isKittyProtocolKey,
  isMouseEvent,
  isX10MouseEvent,
  parseMouseWheel,
  parseX10MouseWheel,
} from "../src/tui/mouse-events.ts";

test("parses X10 wheel button codes from the first payload byte", () => {
  assert.equal(parseX10MouseWheel("\x1b[M`!!"), "up");
  assert.equal(parseX10MouseWheel("\x1b[Ma!!"), "down");
});

test("does not treat an X10 click coordinate as a wheel button", () => {
  assert.equal(parseX10MouseWheel("\x1b[M !`"), undefined);
  assert.equal(parseX10MouseWheel("\x1b[M !a"), undefined);
});

test("recognizes X10 and SGR mouse reports", () => {
  assert.equal(isX10MouseEvent("\x1b[M`!!"), true);
  assert.equal(isMouseEvent("\x1b[<64;20;8M"), true);
  assert.equal(isMouseEvent("\x1b[M"), false);
  assert.equal(parseMouseWheel("\x1b[M`!!"), "up");
});

test("recognizes raw and ESC-stripped Kitty key reports", () => {
  assert.equal(isKittyProtocolKey("\x1b[12;8u"), true);
  assert.equal(isKittyProtocolKey("[12;8u"), true);
  assert.equal(isKittyProtocolKey("[12;8"), false);
});
