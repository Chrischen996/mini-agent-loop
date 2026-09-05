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
  thinkingLevelStatusText,
  type StatusLineInput,
} from "../src/tui/status-line.ts";
import {
  modelNameColumn,
  modelNameLabel,
  pickerHintText,
  pickerMaxVisibleItems,
  pickerRangeText,
  pickerTitleText,
  profileRowText,
  SESSION_PREVIEW_MAX,
  sessionRowContent,
} from "../src/tui/picker-window.ts";
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
    } as never, { input: "/mo" });
    // Ink's CommandPalette heading is `── Commands /mo`; the ANSI palette used
    // to drop the filter, so the same keystrokes produced different headings.
    assert.equal(rows[0]?.text, pickerTitleText("command", { filter: "mo" }));
    assert.equal(rows[0]?.text, "Commands /mo");

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
    } as never, { currentModel: "anthropic/claude-sonnet-4-5" });
    assert.equal(rows[0]?.text, pickerTitleText("model", { query: "" }));
    assert.equal(rows[0]?.text, "Models all");
    // Ink marks the model in use with a ✓; the ANSI picker listed bare
    // references, so neither the mark nor the context column lined up.
    const column = modelNameColumn(models);
    const cell = (model: string) => modelNameLabel(model, model === "anthropic/claude-sonnet-4-5").padEnd(Math.max(column, model.length + 4));
    assert.equal(rows[1]?.text, `❯ ${cell("openai/gpt-4o-mini")}128k context`);
    assert.equal(rows[2]?.text, `  ${cell("anthropic/claude-sonnet-4-5")}200k context`);
    assert.match(rows[2]?.text ?? "", /✓ anthropic\/claude-sonnet-4-5/);
    assert.equal(rows.at(-1)?.text, pickerHintText("model"));
  });

  it("gives every palette row its own spelling", () => {
    const usages = SLASH_COMMANDS.map((command) => command.usage);
    assert.equal(new Set(usages).size, usages.length, "two commands advertise identical usage text");
    const alias = SLASH_COMMANDS.find((command) => command.name === "todo");
    assert.match(alias?.usage ?? "", /^\/todo \[/, "alias row does not show the alias");
  });

  it("clips the ANSI palette at the shared page size and keeps the selection on screen", () => {
    const commands = Array.from({ length: 20 }, (_, index) => ({
      name: `cmd${index}`,
      usage: `/cmd${index}`,
      description: `Command ${index}`,
    }));
    const rows = autocompleteRenderLines({
      mode: "command",
      index: 15,
      commands,
      files: [],
      models: [],
      sessions: [],
      modelContextWindows: {},
      modelQuery: "",
      fileFragment: "",
      sessionLoading: false,
    } as never, { input: "/cmd" });
    // The ANSI overlay used to hardcode twelve rows without scrolling: past row
    // twelve the marker moved off screen behind a `Showing 12 / 20` footer.
    const pageSize = pickerMaxVisibleItems("command");
    assert.equal(pageSize, 6);
    const candidateRows = rows.slice(1, 1 + pageSize);
    assert.equal(candidateRows.length, pageSize);
    assert.equal(rows.length, 1 + pageSize + 2); // title, rows, range, hint
    assert.ok(candidateRows.some((row) => row.text.startsWith("❯ /cmd15")), "selection scrolled off screen");
    assert.deepEqual(candidateRows.map((row) => row.text.slice(2, 8)), ["/cmd10", "/cmd11", "/cmd12", "/cmd13", "/cmd14", "/cmd15"]);
    assert.equal(rows.at(-2)?.text, pickerRangeText(10, pageSize, commands.length));
    assert.equal(rows.at(-2)?.text, "Showing 11-16 / 20");
    assert.equal(rows.at(-1)?.text, pickerHintText("command"));
  });

  it("shrinks the ANSI picker to the frame instead of cutting the welcome panel", () => {
    const state = createInitialState("gpt-4o-mini");
    const models = Array.from({ length: 40 }, (_, index) => `openai/model-${String(index).padStart(2, "0")}`);
    const frame = (height: number) => buildTerminalRenderLines(state, {
      height,
      width: 100,
      header: { title: "mini-agent", version: packageVersion, model: "openai/gpt-4o-mini", cwd: "/home/user/mini-agent-loop", show: true, showWelcome: true },
      promptRule: true,
      input: "/model",
      cursor: 6,
      includeStatus: true,
      currentModel: "openai/gpt-4o-mini",
      autocomplete: {
        mode: "model-picker",
        index: 3,
        commands: [],
        files: [],
        models,
        sessions: [],
        modelContextWindows: {},
        modelQuery: "",
        fileFragment: "",
        sessionLoading: false,
      } as never,
    }).map((row) => `${row.prefix ?? ""}${row.text}`);

    // A 24-row terminal used to keep the full twelve-row picker and clip the
    // welcome panel instead, leaving a borderless box above the prompt.
    const short = frame(24);
    assert.ok(short.length <= 24, `frame overflows: ${short.length} rows`);
    assert.ok(short.some((line) => line.startsWith("╭")), "welcome panel lost its top border");
    assert.ok(short.some((line) => line.startsWith("╰")), "welcome panel lost its bottom border");
    assert.equal(short.filter((line) => line.includes("context")).length, 4);
    assert.ok(short.includes("Showing 1-4 / 40"));
    assert.ok(short.some((line) => line.startsWith("❯ /model")), "prompt disappeared");

    // A tall terminal still gets the shared cap, and a very short one drops the
    // picker entirely, mirroring Ink's overlay guard.
    assert.equal(frame(40).filter((line) => line.includes("context")).length, pickerMaxVisibleItems("model-picker"));
    const tiny = frame(16);
    assert.equal(tiny.filter((line) => line.includes("context")).length, 0);
    assert.ok(tiny.some((line) => line.startsWith("╰")), "welcome panel lost its bottom border");
    assert.ok(tiny.some((line) => line.startsWith("❯ /model")), "prompt disappeared");
  });

  it("drops a candidate list when the frame has no spare rows", () => {
    const palette = {
      mode: "command",
      index: 0,
      commands: SLASH_COMMANDS.slice(0, 4),
      files: [],
      models: [],
      sessions: [],
      modelContextWindows: {},
      modelQuery: "",
      fileFragment: "",
      sessionLoading: false,
    } as never;
    assert.deepEqual(autocompleteRenderLines(palette, { maxItems: 0 }), []);
    // Title, two candidates, clipped-range row, hint.
    assert.equal(autocompleteRenderLines(palette, { maxItems: 2 }).length, 5);
  });

  it("shares the saved-session row between clients", () => {
    const sessions = [{ id: "0123456789abcdef", messageCount: 12, preview: `first ${"x".repeat(80)} last` }];
    const rows = autocompleteRenderLines({
      mode: "session-list",
      index: 0,
      commands: [],
      files: [],
      models: [],
      sessions,
      sessionCommand: "sessions",
      modelContextWindows: {},
      modelQuery: "",
      fileFragment: "",
      sessionLoading: false,
    } as never);
    assert.equal(rows[0]?.text, "Saved sessions");
    // Ink's SessionPalette prints this exact string after its marker column.
    const content = sessionRowContent(sessions[0]);
    assert.equal(rows[1]?.text, `❯ ${content}`);
    // Ink wrapped the full preview to the terminal width while the ANSI
    // renderer clipped it; both now print the same bounded string.
    assert.ok(!content.includes("last"), "preview is not bounded");
    assert.equal(content.length, 12 + 2 + "12 msgs".length + 2 + SESSION_PREVIEW_MAX);
  });

  it("shares the model-profile row, clipped range, and hint", () => {
    const profiles = Array.from({ length: 12 }, (_, index) => ({
      name: `profile-${index}`,
      model: "openai/gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
      active: index === 0,
    }));
    const rows = autocompleteRenderLines({
      mode: "profile-list",
      index: 11,
      commands: [],
      files: [],
      models: [],
      sessions: [],
      modelContextWindows: {},
      modelQuery: "",
      fileFragment: "",
      sessionLoading: false,
      profileListState: { profiles, selectedIndex: 11 },
    } as never);
    const pageSize = pickerMaxVisibleItems("profile-list");
    assert.equal(rows[0]?.text, "Model profiles");
    const candidateRows = rows.slice(1, 1 + pageSize);
    assert.equal(candidateRows.length, pageSize);
    // The ANSI row used to drop the base URL and the delete hint that Ink shows.
    assert.equal(candidateRows.at(-1)?.text, profileRowText(profiles[11], true));
    assert.match(candidateRows.at(-1)?.text ?? "", /^❯   profile-11 \(openai\/gpt-4o-mini\) — https:\/\/api\.openai\.com\/v1$/);
    assert.equal(rows.at(-2)?.text, pickerRangeText(2, pageSize, profiles.length));
    assert.equal(rows.at(-1)?.text, pickerHintText("profile-list"));
    assert.match(rows.at(-1)?.text ?? "", /\/profiles delete <name>/);
  });

  it("reports models that have no reasoning levels to cycle", () => {
    // Ctrl+R clamps to `off` for a non-reasoning model; the old
    // `Thinking level: off` looked like the keypress had changed something.
    assert.equal(
      thinkingLevelStatusText({ reasoning: false, model: "gpt-4o-mini" }, "off"),
      "Thinking levels are not supported by gpt-4o-mini",
    );
    assert.equal(
      thinkingLevelStatusText({ reasoning: true, piModel: undefined, model: "gpt-5" }, "high"),
      "Thinking level: high",
    );
    // The idle status row must actually show it: `statusLabel` maps generic
    // "thinking" text to "Thinking…", which is suppressed as fake activity.
    const unsupported = thinkingLevelStatusText({ reasoning: false, model: "gpt-4o-mini" }, "off");
    assert.equal(statusLabel(unsupported), unsupported);
    assert.equal(idleStatusTail(unsupported, false, ["Plan mode", "off"]), unsupported);
    // A supported model still dedupes against the pinned reasoning segment.
    assert.equal(idleStatusTail("Thinking level: high", false, ["Plan mode", "high"]), undefined);
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
