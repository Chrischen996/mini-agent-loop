import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
  resetTheme,
  resolveInitialThemeName,
} from "../src/tui/theme.ts";
import { formatRenderLine, hexToAnsi } from "../src/tui/render-line-format.ts";
import type { RenderLine } from "../src/tui/render-lines.ts";

after(() => {
  resetTheme();
});

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
