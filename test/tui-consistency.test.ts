import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { TUI_BRAND_VERSION, TUI_WELCOME_PANEL_HEIGHT } from "../src/tui/brand.ts";
import { buildWelcomePanelRows, WELCOME_PANEL_MIN_WIDTH } from "../src/tui/welcome-panel.ts";
import {
  buildStatusSegments,
  formatContextWindow,
  formatStatusLine,
  idleStatusTail,
  STATUS_SEPARATOR,
  type StatusLineInput,
} from "../src/tui/status-line.ts";
import {
  commandUsageColumn,
  formatHelpNotice,
  KNOWN_SLASH_COMMAND_NAMES,
  parseUnknownSlashCommand,
  SLASH_COMMANDS,
} from "../src/tui/slash-commands.ts";
import { autocompleteRenderLines, permissionPanelRenderLines } from "../src/tui/terminal-overlay-lines.ts";
import { CODE_GUTTER, markdownRowText, parseMarkdownLines } from "../src/tui/markdown-lines.ts";
import { terminalStringWidth, truncateTerminalPath } from "../src/tui/terminal-width.ts";
import { buildTerminalRenderLines } from "../src/tui/terminal-render-model.ts";
import { thinkingRenderLines } from "../src/tui/thinking-lines.ts";
import { createInitialState, tuiReducer } from "../src/tui/state.ts";
import { statusLabel } from "../src/tui/claude-style.ts";

/**
 * Regressions for the shared terminal presentation layer.
 *
 * Each test pins a decision that both TUI clients depend on: one status-row
 * builder, one command catalog, one spinner, one markdown projection, and one
 * permission card. They exist because the Ink and ANSI renderers used to
 * compose these independently and drifted into visibly different UIs.
 */
describe("shared TUI presentation", () => {
  const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

  it("advertises the packaged version in the welcome panel", () => {
    assert.equal(TUI_BRAND_VERSION, packageVersion);
    const rows = buildWelcomePanelRows(100, { version: TUI_BRAND_VERSION });
    assert.match(rows[0]?.text ?? "", new RegExp(`mini-agent v${TUI_BRAND_VERSION.replace(/\./g, "\\.")}`));
  });

  it("keeps welcome panel text off the cell borders", () => {
    const width = WELCOME_PANEL_MIN_WIDTH;
    const rows = buildWelcomePanelRows(width, {
      model: "anthropic/claude-sonnet-4-5-20250929",
      cwd: "/Users/someone/Projects/agent loop/mini-agent",
    });
    assert.equal(rows.length, TUI_WELCOME_PANEL_HEIGHT);
    for (const row of rows) assert.equal(terminalStringWidth(row.text), width);

    for (const row of rows.slice(1, -1)) {
      const cells = row.text.slice(1, -1).split("│");
      assert.equal(cells.length, 2, row.text);
      for (const cell of cells) {
        const content = cell.trim();
        // Blank cells and the `─` divider are allowed to touch the borders.
        if (!content || /^─+$/.test(content)) continue;
        assert.equal(cell.startsWith(" "), true, `cell touches its left border: ${JSON.stringify(row.text)}`);
        assert.equal(cell.endsWith(" "), true, `cell touches its right border: ${JSON.stringify(row.text)}`);
      }
    }
  });

  it("formats context windows with the decimal units models publish", () => {
    assert.equal(formatContextWindow(128_000), "128k");
    assert.equal(formatContextWindow(200_000), "200k");
    assert.equal(formatContextWindow(1_000_000), "1M");
    assert.equal(formatContextWindow(999), "999");
  });

  it("orders status segments canonically and fits every terminal width", () => {
    const input: StatusLineInput = {
      modelName: "claude-sonnet",
      cwd: "/workspace/mini-agent",
      permissionMode: "approval",
      thinkingLevel: "high",
      contextTokens: 42_100,
      contextWindow: 200_000,
      busy: false,
      status: "",
      queuedCount: 2,
      cacheReadTokens: 31_000,
      promptTokens: 42_100,
    };

    for (const width of [120, 100, 80, 60, 46, 30, 20, 12]) {
      const line = formatStatusLine({ ...input, width });
      assert.ok(terminalStringWidth(line) <= width, `status row overflows ${width} columns: ${JSON.stringify(line)}`);
      assert.equal(line.startsWith("· "), true, line);
    }

    const canonical = ["marker", "model", "cwd", "mode", "thinking", "context", "status", "queued", "cache"];
    const segments = buildStatusSegments({ ...input, width: 120 });
    const roles = segments.filter((segment) => segment.role !== "sep").map((segment) => segment.role);
    const positions = roles.map((role) => canonical.indexOf(role));
    assert.ok(positions.every((position) => position >= 0), roles.join(","));
    assert.deepEqual(positions, [...positions].sort((left, right) => left - right), roles.join(","));
    assert.deepEqual(
      segments.filter((segment) => segment.role === "sep").map((segment) => segment.text),
      Array.from({ length: roles.length - 2 }, () => STATUS_SEPARATOR),
    );
    // A wide terminal keeps every segment, including the decimal context budget.
    assert.match(formatStatusLine({ ...input, width: 120 }), /Context 42\.1k\/200k/);
  });

  it("does not echo a setting the status row already pins", () => {
    assert.equal(statusLabel("Permission mode: plan"), "Plan mode");
    assert.equal(statusLabel("Thinking level: high"), "high");
    assert.equal(statusLabel("Thinking display: summary"), "Thinking display: summary");

    // The pinned segments already say this; repeating it produced
    // "… · Plan mode · … · Plan mode" after every Shift+Tab.
    assert.equal(idleStatusTail("Permission mode: plan", false, ["Plan mode"]), undefined);
    assert.equal(idleStatusTail("Thinking level: high", false, ["high"]), undefined);
    // Activity wording must not survive onto an idle prompt.
    assert.equal(idleStatusTail("Waiting for permission: write (high)", false, []), undefined);
    assert.equal(idleStatusTail("Working…", true, []), undefined);
    assert.equal(idleStatusTail("", false, []), undefined);
    // Real outcomes are still shown.
    assert.equal(idleStatusTail("Session resumed", false, []), "Session resumed");
  });

  it("guards mistyped slash commands without swallowing path prompts", () => {
    assert.equal(parseUnknownSlashCommand("/deploy the app"), "/deploy");
    assert.equal(parseUnknownSlashCommand("/hepl"), "/hepl");
    assert.equal(parseUnknownSlashCommand("/HELP"), undefined);
    assert.equal(parseUnknownSlashCommand("/model sonnet"), undefined);
    assert.equal(parseUnknownSlashCommand("/home/user/project is broken"), undefined);
    assert.equal(parseUnknownSlashCommand("/usr/local/bin/node --version"), undefined);
    assert.equal(parseUnknownSlashCommand("plain prompt"), undefined);
    assert.equal(parseUnknownSlashCommand(""), undefined);
  });

  it("advertises exactly the commands both clients dispatch", () => {
    const help = formatHelpNotice();
    for (const command of SLASH_COMMANDS) {
      assert.equal(KNOWN_SLASH_COMMAND_NAMES.has(command.name), true, command.name);
      assert.equal(parseUnknownSlashCommand(`/${command.name}`), undefined);
      if (command.alias) continue;
      assert.ok(help.includes(command.usage), `help omits ${command.usage}`);
      assert.ok(help.includes(command.description), `help omits ${command.description}`);
    }
    assert.match(help, /Shift\+Tab permission mode/);
    assert.match(help, /Ctrl\+R reasoning level/);

    // No command may be listed twice, and every row keeps its two columns
    // separated even when a usage string outgrows the aligned column.
    const listed = help.split("\n").filter((row) => row.trim() && !row.includes("·"));
    assert.equal(new Set(listed).size, listed.length, listed.join("\n"));
    for (const row of listed) assert.match(row, /\S {2,}\S/, `help row lost its column gap: ${JSON.stringify(row)}`);

    // Aliases stay accepted but are advertised once, under their canonical name.
    const aliases = SLASH_COMMANDS.filter((command) => command.alias);
    assert.ok(aliases.length > 0);
    for (const alias of aliases) {
      assert.equal(KNOWN_SLASH_COMMAND_NAMES.has(alias.name), true);
      assert.equal(parseUnknownSlashCommand(`/${alias.name}`), undefined);
      assert.equal(help.includes(`/${alias.name} `), false, `help lists the alias /${alias.name}`);
      assert.match(alias.description, /^Alias of \//);
    }
  });

  it("adapts /help to the terminal width", () => {
    for (const width of [120, 100, 80, 60, 46]) {
      const rows = formatHelpNotice(SLASH_COMMANDS, width).split("\n");
      const budget = width - 2; // notices render with a two-column indent
      for (const row of rows) {
        // A stacked description is prose and may wrap; command and hint rows
        // must never be broken mid-token by the notice renderer.
        if (row.startsWith("    ")) continue;
        assert.ok([...row].length <= budget, `help row overflows ${width} columns: ${JSON.stringify(row)}`);
      }
      for (const command of SLASH_COMMANDS.filter((entry) => !entry.alias)) {
        assert.ok(
          rows.some((row) => row.includes(command.usage) || row.trim() === `/${command.name}`),
          `${command.name} disappeared from /help at width ${width}`,
        );
      }
      assert.match(rows.join("\n"), /Shift\+Tab permission mode/);
    }
  });

  it("lists the command palette in usage and description columns", () => {
    const candidates = SLASH_COMMANDS.slice(0, 6);
    const rows = autocompleteRenderLines({
      mode: "command",
      index: 1,
      commands: candidates,
      files: [],
      models: [],
    } as never);
    assert.equal(rows[0]?.text, "Commands");

    // Every description starts in the shared usage column, so the ANSI overlay
    // and the Ink CommandPalette line up row for row.
    const column = commandUsageColumn(candidates);
    assert.equal(rows[1]?.text, `  ${"/model [ref] [url] [key]".padEnd(column)}Switch model and gateway`);
    assert.equal(rows[2]?.text, `❯ ${"/profiles".padEnd(column)}List and activate model profiles`);
    for (const row of rows.slice(1)) {
      const command = candidates.find((entry) => row.text.startsWith(`  ${entry.usage}`) || row.text.startsWith(`❯ ${entry.usage}`));
      if (!command) continue;
      assert.equal(row.text.indexOf(command.description), 2 + Math.max(column, command.usage.length + 2), row.text);
    }
  });

  it("lists the model picker with aligned decimal context sizes", () => {
    const models = ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4-5"];
    const rows = autocompleteRenderLines({
      mode: "model",
      index: 0,
      commands: [],
      files: [],
      models,
      sessions: [],
      modelContextWindows: { "openai/gpt-4o-mini": 128_000, "anthropic/claude-sonnet-4-5": 200_000 },
      modelQuery: "",
      fileFragment: "",
      sessionLoading: false,
    } as never);
    assert.equal(rows[0]?.text, "Models");
    assert.equal(rows[1]?.text, "❯ openai/gpt-4o-mini           128k context");
    assert.equal(rows[2]?.text, "  anthropic/claude-sonnet-4-5  200k context");
  });

  it("renders the permission card with Ink's rows and no foreign branding", () => {
    const rows = permissionPanelRenderLines(
      { requestId: "perm-1", sessionId: "session", tool: "bash", arguments: { command: "rm -rf build" }, risk: "high" },
      80,
    );
    // PermissionPanel.tsx reserves six rows (2 borders + 4 content); the ANSI
    // card used to need seven and repeated its own title inside the box.
    assert.equal(rows.length, 6);
    const text = rows.map((row) => `${row.prefix ?? ""}${row.text}`).join("\n");
    assert.doesNotMatch(text, /claude/i);
    assert.match(text, /Permission required/);
    assert.match(text, /Bash \(rm -rf build\)|Bash \(\$ rm -rf build\)/);
    assert.match(text, /Risk: High risk/);
    assert.match(text, /Do you want to proceed\?/);
    assert.match(text, /A Allow/);
    assert.match(text, /D\/Enter Deny/);
    assert.match(text, /Esc cancel/);
    for (const row of rows) assert.ok(terminalStringWidth(`${row.prefix ?? ""}${row.text}`) <= 80);
  });

  it("projects markdown one row per source line without raw punctuation", () => {
    const source = [
      "## Title",
      "```ts",
      "const a = 1;",
      "```",
      "| Name | Value |",
      "| --- | ---: |",
      "| a | 1 |",
      "plain line with a | pipe",
    ].join("\n");
    const parsed = parseMarkdownLines(source);
    // The viewport height estimate counts source lines, so the projection must
    // stay 1:1 or the feed reserves the wrong number of rows.
    assert.equal(parsed.length, source.split("\n").length);

    const rendered = parsed.map(markdownRowText);
    assert.ok(rendered.every((row) => !row.includes("```")), rendered.join("\n"));
    assert.equal(rendered[0], "▸ Title");
    assert.equal(rendered[1], `${CODE_GUTTER} ts`);
    assert.equal(rendered[2], `${CODE_GUTTER} const a = 1;`);
    assert.equal(rendered[3], CODE_GUTTER);
    assert.equal(rendered[4], `${"Name".padEnd(4)}  Value`);
    assert.equal(rendered[5], `${"─".repeat(4)}  ${"─".repeat(5)}`);
    assert.equal(rendered[6], `${"a".padEnd(4)}  ${"1".padStart(5)}`);
    assert.equal(rendered[7], "plain line with a | pipe");
  });

  it("marks fenced reasoning with the same gutter as answer markdown", () => {
    const rows = thinkingRenderLines(["plan:", "```bash", "npm test", "```"].join("\n"), { mode: "full" });
    assert.deepEqual(rows.map((row) => row.text), ["plan:", `${CODE_GUTTER} bash`, `${CODE_GUTTER} npm test`, CODE_GUTTER]);
  });

  it("pluralizes collapsed-row hints", () => {
    const many = thinkingRenderLines(Array.from({ length: 34 }, (_, index) => `line ${index}`).join("\n"), { mode: "full" });
    assert.match(many.at(-1)?.text ?? "", /··· 4 more lines$/);
    const one = thinkingRenderLines(["a", "b", "c", "d"].join("\n"), { mode: "summary" });
    assert.match(one.at(-1)?.text ?? "", /··· 1 more line$/);
  });

  it("keeps path truncation aligned to path segments", () => {
    const path = "/Users/chenjiaxu/Project/agent loop/mini-agent";
    for (const width of [40, 30, 24, 16, 12]) {
      const compact = truncateTerminalPath(path, width);
      assert.ok(terminalStringWidth(compact) <= width, `${width}: ${compact}`);
      assert.equal(compact.startsWith("…/"), true, compact);
      const suffix = compact.slice(2);
      assert.ok(path.endsWith(`/${suffix}`), `truncation started mid-segment: ${compact}`);
    }
    // Below the last segment's own width only its tail can survive, but it must
    // not carry a stray separator from the segment before it.
    for (const width of [10, 8, 6, 4, 2]) {
      const compact = truncateTerminalPath(path, width);
      assert.ok(terminalStringWidth(compact) <= width, `${width}: ${compact}`);
      assert.equal(compact.includes("/"), false, compact);
    }
  });

  it("renders one spinner row and folds the Todo tip into it", () => {
    const busy = { ...createInitialState("test-model"), busy: true, status: "" };
    const spinnerKeys = (lines: ReturnType<typeof buildTerminalRenderLines>) =>
      lines.filter((line) => line.key === "activity" || line.key.startsWith("loading") || line.key.startsWith("spinner"));

    assert.equal(spinnerKeys(buildTerminalRenderLines(busy, { width: 100, input: "" })).length, 1);

    const withTip = { ...busy, spinnerMessage: "▶ Writing regression tests" };
    const lines = buildTerminalRenderLines(withTip, { width: 100, input: "" });
    const spinners = spinnerKeys(lines);
    assert.equal(spinners.length, 1);
    assert.match(spinners[0]?.text ?? "", /Writing regression tests…/);
    assert.equal(lines.some((line) => line.text.includes("▶")), false);

    // The compact Todo panel names the active step, so the tip must not be
    // repeated on the spinner row two lines below it.
    const withTodos = {
      ...withTip,
      todoViewMode: "compact" as const,
      todoItems: [{
        id: "todo-1",
        content: "Write regression tests",
        activeForm: "Writing regression tests",
        status: "in_progress" as const,
        source: "model" as const,
      }],
    };
    const panelRows = buildTerminalRenderLines(withTodos, { width: 100, input: "" })
      .filter((line) => line.text.includes("Writing regression tests"));
    assert.equal(panelRows.length, 1, panelRows.map((line) => `${line.key}: ${line.text}`).join("\n"));
    assert.equal(panelRows[0]?.key.startsWith("panel-todo"), true);

    // With the panel hidden the tip belongs to the spinner row again.
    const hiddenRows = buildTerminalRenderLines({ ...withTodos, todoViewMode: "hidden" as const }, { width: 100, input: "" })
      .filter((line) => line.text.includes("Writing regression tests"));
    assert.equal(hiddenRows.length, 1);
    assert.equal(hiddenRows[0]?.key, "activity");
  });

  it("renders tool results as a compact gutter instead of a card", () => {
    const call = { id: "tool-1", name: "bash", arguments: { command: "seq 1 16" } };
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "LOOP_EVENT", event: { type: "tool_start", call } });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "tool_end", call, result: { content: Array.from({ length: 16 }, (_, index) => `line ${index}`).join("\n"), isError: false } },
    });

    const rows = buildTerminalRenderLines(state, { width: 100 }).filter(
      (line) => line.key.includes("message-0-tool") || line.key.includes("message-0-result"),
    );
    assert.equal(rows[0]?.prefix, "✓ ");
    assert.match(rows[0]?.text ?? "", /^Bash\(seq 1 16\)/);
    assert.equal(rows[1]?.prefix, "  ⎿ ");
    assert.equal(rows.some((row) => /[╭╰│]/.test(row.text)), false);
    for (const row of rows.slice(2)) assert.equal(row.prefix, "     ");
    assert.match(rows.at(-1)?.text ?? "", /1 more line$/);
  });
});
