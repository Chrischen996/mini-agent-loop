/**
 * Terminal palette selection for the TUI, modeled on gemini-cli's theme
 * system (packages/cli/src/ui/themes): a set of built-in palettes described
 * as gemini `ColorsTheme` blocks, translated into the semantic slots the
 * renderer already uses.
 *
 * The active palette is the mutable `TUI_COLORS` singleton — components read
 * it at render time, so `applyTheme()` re-colors the live frame without any
 * remounting. Emissions already frozen into the scrollback keep their old
 * colors (same behavior as gemini's static history).
 *
 * Selection order at startup (applied by the TUI entry, NOT at import, so
 * tests always see the default palette): `MINI_AGENT_THEME` env →
 * `~/.mini-agent/theme.json` (persisted by `/theme`) → `claude-dark`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GEMINI_BUILTIN_COLORS, type GeminiColorsTheme } from "./gemini-palettes.ts";

export type TuiPalette = {
  primary: string;       // identity accent for assistant headings / branding
  info: string;          // models, paths, tool labels
  planMode: string;      // plan-mode indicator
  user: string;          // user prompt text and markers
  assistant: string;     // main response body text
  muted: string;         // metadata, hints, secondary labels
  border: string;        // quiet panel borders
  inputBorder: string;   // input container border
  selection: string;     // selected-row background in pickers
  thinking: string;      // reasoning / thinking blocks
  running: string;       // in-progress work (spinners, live tools)
  success: string;       // completed work
  error: string;         // errors and rejections
  badgeText: string;     // readable text on colored status badges
  userBg: string;        // user-message background tint
  gutter: string;        // gutter marks
  inlineCodeBg: string;  // inline code span background
};

/** The historical Claude-branded palette; remains the default theme. */
const CLAUDE_DARK: TuiPalette = {
  primary: "#d77757",
  info: "#b1b9f9",
  planMode: "#48968c",
  user: "#7ab4e8",
  assistant: "#ffffff",
  muted: "#999999",
  border: "#505050",
  inputBorder: "#6b7280",
  selection: "#264f78",
  thinking: "#af87ff",
  running: "#ffc107",
  success: "#4eba65",
  error: "#ff6b80",
  badgeText: "#000000",
  userBg: "#373737",
  gutter: "#505050",
  inlineCodeBg: "#3a4149",
};

function first(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value) return value;
  }
  return "";
}

/** Translate a gemini ColorsTheme block into the renderer's semantic slots. */
export function derivePalette(colors: GeminiColorsTheme): TuiPalette {
  return {
    primary: first(colors.GradientColors?.[1], colors.AccentPurple, colors.AccentBlue),
    info: first(colors.LightBlue, colors.AccentBlue),
    planMode: first(colors.AccentCyan, colors.AccentGreen),
    user: first(colors.AccentBlue, colors.LightBlue),
    assistant: first(colors.Foreground),
    muted: first(colors.Gray, colors.Comment),
    border: first(colors.DarkGray, colors.Gray),
    inputBorder: first(colors.Gray, colors.DarkGray),
    selection: first(colors.FocusBackground, colors.MessageBackground, colors.AccentPurple),
    thinking: first(colors.AccentPurple, colors.AccentBlue),
    running: first(colors.AccentYellow, colors.AccentRed),
    success: first(colors.AccentGreen, colors.DiffAdded),
    error: first(colors.AccentRed, colors.DiffRemoved),
    badgeText: colors.type === "light" ? first(colors.Foreground) : first(colors.Background),
    userBg: first(colors.MessageBackground, colors.InputBackground, colors.DarkGray),
    gutter: first(colors.DarkGray, colors.Gray),
    inlineCodeBg: first(colors.InputBackground, colors.MessageBackground, colors.DarkGray),
  };
}

const PALETTES: Record<string, TuiPalette> = { "claude-dark": CLAUDE_DARK };
for (const [name, colors] of Object.entries(GEMINI_BUILTIN_COLORS)) {
  PALETTES[name] = derivePalette(colors);
}

export const DEFAULT_THEME_NAME = "claude-dark";

/** Theme ids accepted by `/theme` and `MINI_AGENT_THEME`. */
export const THEME_NAMES: readonly string[] = Object.keys(PALETTES);

/** Live palette singleton; mutated by applyTheme(). Import as `C` for reads. */
export const TUI_COLORS: TuiPalette = { ...CLAUDE_DARK };

let activeTheme = DEFAULT_THEME_NAME;

export function activeThemeName(): string {
  return activeTheme;
}

/** Switch the live palette. Returns false (no change) for unknown names. */
export function applyTheme(name: string | undefined): boolean {
  if (!name) return false;
  const palette = PALETTES[name.toLowerCase()];
  if (!palette) return false;
  Object.assign(TUI_COLORS, palette);
  activeTheme = name.toLowerCase();
  return true;
}

/** Restore the default palette (used by tests and `/theme claude-dark`). */
export function resetTheme(): void {
  applyTheme(DEFAULT_THEME_NAME);
}

export const THEME_ENV = "MINI_AGENT_THEME";

/** JSON store for the persisted selection, mirroring the model-profile store. */
export function resolveThemeStorePath(env: Record<string, string | undefined> = process.env): string {
  return env.MINI_AGENT_THEME_CONFIG || path.join(os.homedir(), ".mini-agent", "theme.json");
}

export function readStoredThemeName(env: Record<string, string | undefined> = process.env): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(resolveThemeStorePath(env), "utf8")) as { theme?: unknown };
    return typeof raw.theme === "string" ? raw.theme : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort persistence of the selection; returns false when unwritable. */
export function persistThemeName(name: string, env: Record<string, string | undefined> = process.env): boolean {
  try {
    const storePath = resolveThemeStorePath(env);
    mkdirSync(path.dirname(storePath), { recursive: true });
    writeFileSync(storePath, JSON.stringify({ version: 1, theme: name }, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** env override -> persisted selection -> default. Invalid values fall through. */
export function resolveInitialThemeName(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[THEME_ENV]?.toLowerCase();
  if (fromEnv && PALETTES[fromEnv]) return fromEnv;
  const stored = readStoredThemeName(env)?.toLowerCase();
  if (stored && PALETTES[stored]) return stored;
  return DEFAULT_THEME_NAME;
}

/** Apply the startup selection (called once by the TUI entry point). */
export function initTheme(env: Record<string, string | undefined> = process.env): string {
  const name = resolveInitialThemeName(env);
  applyTheme(name);
  return name;
}

/**
 * Whether the user has an explicit theme selection (env or persisted store).
 * False means startup should show the theme dialog (gemini-cli first-run).
 */
export function hasThemeSelection(env: Record<string, string | undefined> = process.env): boolean {
  const fromEnv = env[THEME_ENV]?.toLowerCase();
  if (fromEnv && PALETTES[fromEnv]) return true;
  const stored = readStoredThemeName(env)?.toLowerCase();
  return !!stored && !!PALETTES[stored];
}

/**
 * Whether the first-run theme dialog should open: real interactive TTY,
 * outside the node:test runner (its child processes carry NODE_TEST_CONTEXT,
 * including TUI app instances spawned from tests), and no explicit selection
 * yet. `/theme` always opens the dialog regardless.
 */
export function shouldPromptForThemeAtStartup(
  env: Record<string, string | undefined> = process.env,
  isTty: boolean = process.stdout.isTTY === true,
): boolean {
  if (!isTty || env.NODE_TEST_CONTEXT) return false;
  return !hasThemeSelection(env);
}

/** Human-readable theme listing for `/theme` (current one marked). */
export function formatThemeListText(): string {
  const lines = [`Available themes (${THEME_NAMES.length}) - use /theme <name>:`, ""];
  for (const name of THEME_NAMES) {
    lines.push(`  ${name === activeTheme ? "❯" : " "} ${name}`);
  }
  return lines.join("\n");
}

