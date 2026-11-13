/// <reference types="../ink-testing-library.d.ts" />
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import React from "react";
import { ThemeDialog } from "../src/tui/components/ThemeDialog.tsx";
import {
  THEME_NAMES,
  DEFAULT_THEME_NAME,
  TUI_COLORS,
  activeThemeName,
  applyTheme,
  derivePalette,
  formatThemeListText,
  persistThemeName,
  readStoredThemeName,
  hasThemeSelection,
  resetTheme,
  resolveInitialThemeName,
  shouldPromptForThemeAtStartup,
} from "../src/tui/theme.ts";
import { formatRenderLine, hexToAnsi } from "../src/tui/render-line-format.ts";
import type { RenderLine } from "../src/tui/render-lines.ts";

after(() => {
  resetTheme();
});

let render: typeof import("ink-testing-library").render | undefined;
try {
  ({ render } = await import("ink-testing-library"));
} catch {
  // ink-testing-library unavailable; ThemeDialog suite is skipped
}

describe("theme registry", () => {
  it("keeps claude-dark first and ports the gemini catalogue", () => {
    assert.equal(THEME_NAMES[0], DEFAULT_THEME_NAME);
    for (const name of ["gemini-dark", "gemini-light", "solarized-dark", "tokyonight-dark", "dracula-dark", "ansi-dark", "xcode-light"]) {
      assert.ok(THEME_NAMES.includes(name), `missing ${name}`);
    }
  });

  it("applyTheme swaps the live palette in place and unknown names no-op", () => {
    const reference = TUI_COLORS;
    assert.equal(applyTheme("Solarized-Dark"), true);
    assert.equal(TUI_COLORS, reference, "same object identity, mutated in place");
    assert.equal(activeThemeName(), "solarized-dark");
    assert.equal(TUI_COLORS.assistant, "#839496");
    assert.equal(TUI_COLORS.error, "#dc322f");
    assert.equal(applyTheme("definitely-not-a-theme"), false);
    assert.equal(activeThemeName(), "solarized-dark");
    resetTheme();
    assert.equal(activeThemeName(), DEFAULT_THEME_NAME);
    assert.equal(TUI_COLORS.assistant, "#ffffff");
  });

  it("derivePalette falls back along the gemini slot chain", () => {
    const sparse = derivePalette({ type: "dark", AccentBlue: "#111111" });
    assert.equal(sparse.user, "#111111");
    assert.equal(sparse.primary, "#111111");
    assert.equal(sparse.info, "#111111");
    assert.equal(sparse.assistant, "");
  });
});

describe("theme selection", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "theme-store-"));
  const store = path.join(dir, "theme.json");
  const env = { MINI_AGENT_THEME_CONFIG: store };

  it("persists and re-reads the selection", () => {
    assert.equal(persistThemeName("ayu-dark", env), true);
    assert.equal(readStoredThemeName(env), "ayu-dark");
    assert.match(readFileSync(store, "utf8"), /"theme": "ayu-dark"/);
  });

  it("resolution order is env, then store, then default", () => {
    assert.equal(resolveInitialThemeName({ ...env, MINI_AGENT_THEME: "dracula-dark" }), "dracula-dark");
    assert.equal(resolveInitialThemeName(env), "ayu-dark");
    assert.equal(resolveInitialThemeName({ ...env, MINI_AGENT_THEME: "bogus" }), "ayu-dark");
    assert.equal(resolveInitialThemeName({ MINI_AGENT_THEME_CONFIG: path.join(dir, "missing.json") }), DEFAULT_THEME_NAME);
  });

  it("formatThemeListText marks the active theme", () => {
    const text = formatThemeListText();
    assert.match(text, new RegExp(`❯ ${DEFAULT_THEME_NAME}`));
    assert.match(text, /Available themes \(\d+\)/);
  });
});

describe("ANSI emission of themed colors", () => {
  const row = (over: Partial<RenderLine>): RenderLine => ({ key: "k", text: "hello", style: "assistant", ...over });

  it("hexToAnsi accepts hex, short hex, ANSI names, and empty strings", () => {
    assert.equal(hexToAnsi("#ff8800"), "38;2;255;136;0");
    assert.equal(hexToAnsi("#444"), "38;2;68;68;68");
    assert.equal(hexToAnsi("blue"), "34");
    assert.equal(hexToAnsi("bluebright"), "94");
    assert.equal(hexToAnsi(""), "");
    assert.equal(hexToAnsi("nonsense"), "38;5;7");
  });

  it("default palette keeps the legacy 256-color backgrounds", () => {
    const out = formatRenderLine(row({ style: "user", background: "user" }));
    assert.match(out, /48;5;236/);
  });

  it("themed palettes emit truecolor backgrounds from the palette slots", () => {
    applyTheme("solarized-dark");
    // userBg falls back to DarkGray #073642 for solarized.
    assert.match(formatRenderLine(row({ style: "user", background: "user" })), /48;2;7;54;66/);
    resetTheme();
  });

  it("ANSI-name themes emit basic SGR codes and skip empty ones", () => {
    applyTheme("ansi-dark");
    const user = formatRenderLine(row({ style: "user", text: "hi" }));
    // AccentBlue -> "blue" -> basic foreground 34.
    assert.match(user, /^\x1b\[34m/);
    // Foreground is "" for ansi-dark: assistant rows carry no color sequence.
    assert.equal(formatRenderLine(row({ text: "plain" })), "plain\x1b[0m");
    resetTheme();
  });
});


describe("hasThemeSelection", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "theme-sel-"));
  const store = path.join(dir, "theme.json");

  it("is false when neither env nor store carries a valid theme", () => {
    assert.equal(hasThemeSelection({ MINI_AGENT_THEME_CONFIG: path.join(dir, "missing.json") }), false);
    assert.equal(hasThemeSelection({ MINI_AGENT_THEME_CONFIG: store, MINI_AGENT_THEME: "bogus" }), false);
  });

  it("is true for a valid env or persisted selection", () => {
    assert.equal(hasThemeSelection({ MINI_AGENT_THEME: "ayu-dark", MINI_AGENT_THEME_CONFIG: path.join(dir, "missing.json") }), true);
    writeFileSync(store, JSON.stringify({ version: 1, theme: "dracula-dark" }), "utf8");
    assert.equal(hasThemeSelection({ MINI_AGENT_THEME_CONFIG: store }), true);
  });

  it("startup prompting is suppressed on non-TTY, under the test runner, or with a selection", () => {
    assert.equal(shouldPromptForThemeAtStartup({}, false), false, "not a TTY");
    assert.equal(shouldPromptForThemeAtStartup({ NODE_TEST_CONTEXT: "child-v8" }, true), false, "test child");
    assert.equal(shouldPromptForThemeAtStartup({ MINI_AGENT_THEME_CONFIG: path.join(dir, "missing.json") }, true), true, "interactive first run");
    assert.equal(shouldPromptForThemeAtStartup({ MINI_AGENT_THEME_CONFIG: store }, true), false, "already chosen");
    assert.equal(shouldPromptForThemeAtStartup({ MINI_AGENT_THEME_CONFIG: store, MINI_AGENT_THEME_PROMPT: "always" }, true), true, "always mode re-prompts");
    assert.equal(shouldPromptForThemeAtStartup({ MINI_AGENT_THEME_PROMPT: "never" }, true), false, "never mode silences first run");
  });
});

describe("ThemeDialog (first-run picker)", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

  it("previews live on navigation, commits on enter, reverts on escape", async (t) => {
    if (!render) {
      t.skip();
      return;
    }
    resetTheme();
    let selected: string | undefined;
    const view = render(React.createElement(ThemeDialog, {
      onSelect: (name: string) => {
        selected = name;
        applyTheme(name);
      },
      onCancel: () => {},
    }));
    await tick();
    assert.match(view.lastFrame() ?? "", /Select a theme/);

    view.stdin.write("\x1b[B"); // down: live-preview the next theme
    await tick();
    const previewed = activeThemeName();
    assert.notEqual(previewed, DEFAULT_THEME_NAME, "highlight applies the palette live");

    view.stdin.write("\x1b[A"); // up: preview reverts via the previous entry
    await tick();
    assert.equal(activeThemeName(), DEFAULT_THEME_NAME);

    view.stdin.write("\x1b[B");
    await tick();
    view.stdin.write("\r");
    await tick();
    assert.equal(selected, previewed);
    view.unmount();
    resetTheme();

    let cancelled = false;
    const view2 = render(React.createElement(ThemeDialog, {
      onSelect: () => {},
      onCancel: () => {
        cancelled = true;
      },
    }));
    await tick();
    view2.stdin.write("\x1b[B");
    await tick();
    assert.notEqual(activeThemeName(), DEFAULT_THEME_NAME, "second mount previews the next entry live");
    view2.stdin.write("\x1b");
    await tick();
    assert.equal(cancelled, true);
    assert.equal(activeThemeName(), DEFAULT_THEME_NAME, "escape restores the pre-dialog theme");
    view2.unmount();
    resetTheme();
  });
});
