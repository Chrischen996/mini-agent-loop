import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyTheme, resetTheme, THEME_NAMES } from "../src/tui/theme.ts";
import { toolStatusIcon } from "../src/tui/tool-lines.ts";
import { todoIcon, todoProgressMeter } from "../src/tui/todo-format.ts";
import { getSpinnerFrame, spinnerFrames, CLAUDE_SPINNER_FRAMES } from "../src/tui/loading.ts";
import { buildWelcomePanelRows, WELCOME_PANEL_MIN_WIDTH } from "../src/tui/welcome-panel.ts";
import { terminalStringWidth } from "../src/tui/terminal-width.ts";
import { isPixelTheme } from "../src/tui/pixel-glyphs.ts";

after(() => {
  resetTheme();
});

describe("mario pixel theme registry", () => {
  it("exposes the pixel themes through /theme", () => {
    assert.ok(THEME_NAMES.includes("mario-classic"));
    assert.ok(THEME_NAMES.includes("mario-underwater"));
  });

  it("keeps the default theme on the framework glyphs", () => {
    resetTheme();
    assert.equal(isPixelTheme(), false);
    assert.equal(toolStatusIcon("done"), "✓");
    assert.equal(toolStatusIcon("running"), "⟳");
    assert.equal(toolStatusIcon("error"), "✗");
    assert.equal(spinnerFrames(), CLAUDE_SPINNER_FRAMES);
    assert.equal(todoProgressMeter(3, 6), "▰▰▰▱▱▱");
  });
});

describe("mario pixel glyphs", () => {
  after(() => resetTheme());

  it("swaps status markers when the pixel theme is applied", () => {
    assert.equal(applyTheme("mario-classic"), true);
    assert.equal(isPixelTheme(), true);
    assert.equal(toolStatusIcon("done"), "★");
    assert.equal(toolStatusIcon("running"), "◉");
    assert.equal(toolStatusIcon("partial"), "◐");
    assert.equal(toolStatusIcon("error"), "✕");
    assert.equal(todoIcon("completed"), "★");
    assert.equal(todoIcon("pending"), "□");
  });

  it("renders the todo meter as coins collected out of bricks", () => {
    applyTheme("mario-classic");
    assert.equal(todoProgressMeter(3, 6), "◉◉◉□□□");
    assert.equal(todoProgressMeter(0, 6), "□□□□□□");
    assert.equal(todoProgressMeter(6, 6), "◉◉◉◉◉◉");
  });

  it("animates a four-frame coin spin", () => {
    applyTheme("mario-classic");
    assert.deepEqual([...spinnerFrames()], ["◉", "◎", "○", "◎"]);
    assert.equal(getSpinnerFrame(0), "◉");
    assert.equal(getSpinnerFrame(1), "◎");
    assert.equal(getSpinnerFrame(4), "◉", "wraps back to the first frame");
    assert.equal(getSpinnerFrame(-1), "◎", "negative indices wrap forwards");
    for (let index = 0; index < 8; index += 1) {
      assert.equal(terminalStringWidth(getSpinnerFrame(index)), 1, "coin stays single-width");
    }
  });

  it("draws the question-block welcome art without breaking panel geometry", () => {
    applyTheme("mario-classic");
    const rows = buildWelcomePanelRows(WELCOME_PANEL_MIN_WIDTH, { model: "test-model" });
    assert.equal(rows.length, 10, "panel height budget is unchanged");
    for (const row of rows) assert.equal(terminalStringWidth(row.text), WELCOME_PANEL_MIN_WIDTH);
    assert.ok(rows.some((row) => row.kind === "art" && row.text.includes("★")), "star block is rendered");
  });

  it("restores the framework glyphs when leaving the pixel theme", () => {
    applyTheme("mario-classic");
    assert.equal(toolStatusIcon("done"), "★");
    applyTheme("claude-dark");
    assert.equal(isPixelTheme(), false);
    assert.equal(toolStatusIcon("done"), "✓");
    assert.equal(spinnerFrames(), CLAUDE_SPINNER_FRAMES);
    const rows = buildWelcomePanelRows(WELCOME_PANEL_MIN_WIDTH);
    assert.ok(rows.some((row) => row.text.includes("▗█████▖")), "brand art is restored");
  });

  it("reuses the pixel glyph set for the underwater variant", () => {
    applyTheme("mario-underwater");
    assert.equal(toolStatusIcon("running"), "◉");
    assert.equal(spinnerFrames().length, 4);
  });
});
