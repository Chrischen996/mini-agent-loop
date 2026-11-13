import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_TUI_LAYOUT_MODE, resolveTuiLayoutMode } from "../src/tui/layout-mode.ts";

describe("tui layout mode", () => {
  it("defaults to the document full-flow layout without an env override", () => {
    assert.equal(resolveTuiLayoutMode({}), DEFAULT_TUI_LAYOUT_MODE);
    assert.equal(resolveTuiLayoutMode({}), "document");
  });

  it("selects the inline scrollback layout via MINI_AGENT_TUI_LAYOUT", () => {
    assert.equal(resolveTuiLayoutMode({ MINI_AGENT_TUI_LAYOUT: "inline" }), "inline");
    assert.equal(resolveTuiLayoutMode({ MINI_AGENT_TUI_LAYOUT: "  INLINE " }), "inline");
  });

  it("keeps alternate selection explicit and falls back on garbage", () => {
    assert.equal(resolveTuiLayoutMode({ MINI_AGENT_TUI_LAYOUT: "alternate" }), "alternate");
    assert.equal(resolveTuiLayoutMode({ MINI_AGENT_TUI_LAYOUT: "alt" }), "alternate");
    assert.equal(resolveTuiLayoutMode({ MINI_AGENT_TUI_LAYOUT: "fullscreen" }), "document");
    assert.equal(resolveTuiLayoutMode({ MINI_AGENT_TUI_LAYOUT: "" }), "document");
    assert.equal(resolveTuiLayoutMode({ MINI_AGENT_TUI_LAYOUT: undefined }), "document");
  });
});
