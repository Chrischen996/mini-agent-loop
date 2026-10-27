import assert from "node:assert/strict";
import test from "node:test";
import { kittyScrollAction } from "../src/tui/kitty-scroll.ts";

test("maps Kitty Ctrl+Up with Ctrl+Shift+Alt modifier parameter ;8u to transcript scrolling", () => {
  assert.deepEqual(kittyScrollAction("[12;8u", 20), { type: "SCROLL_BY", delta: 1 });
});

test("preserves Kitty page scrolling and Ctrl+Down and Ctrl+G mappings", () => {
  assert.deepEqual(kittyScrollAction("[9u", 20), { type: "SCROLL_BY", delta: 18 });
  assert.deepEqual(kittyScrollAction("[10u", 20), { type: "SCROLL_BY", delta: -18 });
  assert.deepEqual(kittyScrollAction("[14;5u", 20), { type: "SCROLL_BY", delta: -1 });
  assert.deepEqual(kittyScrollAction("[103;5u", 20), { type: "SCROLL_TO_BOTTOM" });
});
