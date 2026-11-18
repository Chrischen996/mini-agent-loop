import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyTheme, resetTheme } from "../src/tui/theme.ts";
import {
  isPixelTheme,
  panelBorderStyle,
  panelBorderGlyphs,
  type PanelBorder,
} from "../src/tui/pixel-glyphs.ts";
import {
  panelTopLine,
  panelContentLine,
  panelBottomLine,
  permissionPanelRenderLines,
  planApprovalRenderLines,
  todoEditorRenderLines,
} from "../src/tui/terminal-overlay-lines.ts";
import type { PendingPermissionState } from "../src/tui/state.ts";
import type { ExecutionPlan } from "../src/plan-act/types.ts";
import { createTodoEditorState } from "../src/tui/todo-editor.ts";
import type { TodoItem } from "../src/todo.ts";
import { terminalStringWidth } from "../src/tui/terminal-width.ts";

/**
 * P0-3 guard: panel row budgets (App.tsx `permissionRows` / `planApprovalRows`)
 * are hand-written magic numbers. Swapping border characters must never add a
 * row, or the feed height math breaks and Ink clears the whole screen.
 */

const PERMISSION_REQUEST: PendingPermissionState = {
  requestId: "req-1",
  sessionId: "session-1",
  tool: "bash",
  arguments: { command: "ls -la" },
  risk: "high",
};

function makePlan(steps: number): ExecutionPlan {
  return {
    id: "plan-1",
    sessionId: "session-1",
    createdAt: Date.now(),
    summary: "Refactor the rendering pipeline",
    steps: Array.from({ length: steps }, (_, index) => ({
      id: `step-${index + 1}`,
      order: index + 1,
      description: `Step ${index + 1} description`,
      tool: "edit",
      arguments: {},
      risk: "medium",
      rationale: "needed",
      status: index === 0 ? "completed" : "pending",
    })),
    risks: [],
    requiredTools: ["edit"],
    status: "pending_review",
  };
}

const TODOS: TodoItem[] = [
  { id: "t1", content: "First task", activeForm: "Doing first task", status: "completed", source: "model" },
  { id: "t2", content: "Second task", activeForm: "Doing second task", status: "in_progress", source: "model" },
  { id: "t3", content: "Third task", activeForm: "Doing third task", status: "pending", source: "model" },
];

function rowDisplayWidth(row: { text: string; prefix?: string }): number {
  return terminalStringWidth(`${row.prefix ?? ""}${row.text}`);
}

after(() => {
  resetTheme();
});

describe("panel border theme invariants (P0-3 row-budget guard)", () => {
  it("keeps the default theme on framework border glyphs", () => {
    resetTheme();
    assert.equal(isPixelTheme(), false);
    const glyphs = panelBorderGlyphs();
    assert.deepEqual(glyphs, {
      topCorner: "╭", topMid: "─", topRightCorner: "╮",
      side: "│", sideEnd: "│",
      bottomCorner: "╰", bottomMid: "─", bottomRightCorner: "╯",
    });
    assert.equal(panelBorderStyle(), "round");
    assert.equal(panelBorderStyle("single"), "single");
  });

  it("returns the 8-glyph block set for the pixel theme", () => {
    applyTheme("mario-classic");
    const style = panelBorderStyle();
    assert.ok(style !== "round" && style !== "single", "pixel theme must not use a preset name");
    const border = style as PanelBorder;
    assert.deepEqual(border, {
      topLeft: "▛", top: "▀", topRight: "▜",
      right: "▐", bottomRight: "▟", bottom: "▄",
      bottomLeft: "▙", left: "▌",
    });
    // The Ink geometry budget only holds if every border glyph is single-width.
    for (const [field, glyph] of Object.entries(border)) {
      assert.equal(terminalStringWidth(glyph), 1, `border glyph ${field} must be single-width`);
    }
    assert.deepEqual(panelBorderGlyphs(), {
      topCorner: "▛", topMid: "▀", topRightCorner: "▜",
      side: "▌", sideEnd: "▐",
      bottomCorner: "▙", bottomMid: "▄", bottomRightCorner: "▟",
    });
  });

  it("renders the permission card as exactly 6 rows in both themes", () => {
    resetTheme();
    const defaultRows = permissionPanelRenderLines(PERMISSION_REQUEST, 60);
    assert.equal(defaultRows.length, 6, "1 top border + 4 content rows + 1 bottom border");
    applyTheme("mario-classic");
    const pixelRows = permissionPanelRenderLines(PERMISSION_REQUEST, 60);
    assert.equal(pixelRows.length, defaultRows.length, "pixel borders must not add or drop rows");
  });

  it("keeps plan approval and todo editor row counts equal across themes", () => {
    for (const width of [undefined, 48, 90] as const) {
      resetTheme();
      const defaultPlan = planApprovalRenderLines(makePlan(6), width as number);
      const defaultTodo = todoEditorRenderLines(
        createTodoEditorState(TODOS),
        width as number,
      );
      applyTheme("mario-classic");
      const pixelPlan = planApprovalRenderLines(makePlan(6), width as number);
      const pixelTodo = todoEditorRenderLines(createTodoEditorState(TODOS), width as number);
      assert.equal(pixelPlan.length, defaultPlan.length, `plan approval row count at width=${String(width)}`);
      assert.equal(pixelTodo.length, defaultTodo.length, `todo editor row count at width=${String(width)}`);
      // The default-theme plan card is the documented shape: top + summary +
      // 4 steps + "more" + risks + options + keys + bottom.
      assert.equal(defaultPlan.length, 11, `plan card should be 11 rows at width=${String(width)}`);
    }
  });

  it("keeps the headless width contract: every row is exactly `width` wide", () => {
    for (const themeName of ["claude-dark", "mario-classic"] as const) {
      applyTheme(themeName);
      for (const width of [40, 60, 120]) {
        const rows = [
          panelTopLine("top", "⚠ Permission required", width, "running"),
          panelContentLine("content", "bash (ls -la)", "assistant", { width, tone: "running", bold: true }),
          panelBottomLine("bottom", width),
          ...permissionPanelRenderLines(PERMISSION_REQUEST, width),
        ];
        for (const row of rows) {
          assert.equal(
            rowDisplayWidth(row),
            width,
            `${themeName} row must be ${width} columns wide: ${JSON.stringify(row)}`,
          );
        }
      }
    }
  });

  it("keeps the width-undefined branch prefixes at display width 3", () => {
    for (const themeName of ["claude-dark", "mario-classic"] as const) {
      applyTheme(themeName);
      const top = panelTopLine("top", "⚠ Permission required");
      const content = panelContentLine("content", "bash (ls -la)", "assistant");
      const bottom = panelBottomLine("bottom");
      assert.equal(terminalStringWidth(top.prefix ?? ""), 3, `${themeName} top prefix must be 3 wide`);
      assert.equal(terminalStringWidth(content.prefix ?? ""), 3, `${themeName} content prefix must be 3 wide`);
      assert.equal(terminalStringWidth(bottom.prefix ?? ""), 3, `${themeName} bottom prefix must be 3 wide`);
      assert.equal(top.text, "⚠ Permission required", "caption stays the row text in the unbounded branch");
    }
  });

  it("keeps the default-theme headless output byte-identical to the hardcoded original", () => {
    resetTheme();
    // Original hardcoded shapes from terminal-overlay-lines.ts pre-P0-2:
    assert.equal(
      panelTopLine("k", "Todo editor", 24).text,
      `╭─ Todo editor ${"─".repeat(24 - 2 - terminalStringWidth("─ Todo editor "))}╮`,
    );
    assert.equal(panelContentLine("k", "short", "muted", { width: 24 }).text, `short${" ".repeat(24 - 4 - 5)} │`);
    assert.equal(panelContentLine("k", "short", "muted", { width: 24 }).prefix, "│ ");
    assert.equal(panelBottomLine("k", 24).text, `╰${"─".repeat(22)}╯`);
    assert.equal(panelTopLine("k", "Todo editor").prefix, "╭─ ");
    assert.equal(panelContentLine("k", "short", "muted").prefix, "│  ");
    assert.equal(panelBottomLine("k").prefix, "╰─ ");
  });

  it("swaps the border corners in the pixel theme", () => {
    applyTheme("mario-classic");
    assert.equal(panelTopLine("k", "Todo editor", 24).text.charAt(0), "▛");
    assert.equal(panelTopLine("k", "Todo editor", 24).text.slice(-1), "▜");
    assert.equal(panelBottomLine("k", 24).text.charAt(0), "▙");
    assert.equal(panelBottomLine("k", 24).text.slice(-1), "▟");
    assert.equal(panelContentLine("k", "short", "muted", { width: 24 }).prefix, "▌ ");
    assert.equal(panelContentLine("k", "short", "muted", { width: 24 }).text.slice(-1), "▐");
  });

  it("restores the framework borders when leaving the pixel theme", () => {
    applyTheme("mario-classic");
    assert.equal(panelTopLine("k", "x", 24).text.charAt(0), "▛");
    applyTheme("claude-dark");
    assert.equal(isPixelTheme(), false);
    assert.equal(panelTopLine("k", "x", 24).text.charAt(0), "╭");
    assert.equal(panelBottomLine("k", 24).text, `╰${"─".repeat(22)}╯`);
  });
});
