import type { RenderLine } from "./render-lines.ts";
import { terminalStringWidth } from "./terminal-width.ts";
import { TUI_BRAND_NAME, TUI_BRAND_VERSION, TUI_WELCOME_PANEL_HEIGHT } from "./brand.ts";

export type WelcomePanelData = {
  title?: string;
  version?: string;
  model?: string;
  billing?: string;
  cwd?: string;
  tips?: string[];
  updates?: string[];
};

export type WelcomePanelRowKind = "border" | "heading" | "art" | "body";

export type WelcomePanelRow = {
  text: string;
  kind: WelcomePanelRowKind;
};

const DEFAULT_TIPS = [
  "Use /help to see available commands",
  "Use /model to choose a provider and model",
];

const DEFAULT_UPDATES = [
  "Sessions resume with /resume",
  "Plans and Todo stay visible across turns",
  "Tools and subagents stream live status",
];

const BRAND_ART = [
  " ▗█████▖ ",
  "▝▜█████▛▘",
  "  ▘▘ ▝▝  ",
] as const;

/** The wide welcome panel is intentionally unavailable below this width. */
export const WELCOME_PANEL_MIN_WIDTH = 70;

export function getWelcomeHeaderHeight(width: number | undefined, showWelcome: boolean | undefined): number {
  return showWelcome && (width ?? 0) >= WELCOME_PANEL_MIN_WIDTH ? TUI_WELCOME_PANEL_HEIGHT : 3;
}

/**
 * Build the fixed-width welcome frame used by ANSI, legacy, and Ink paths.
 * Keeping the row geometry here prevents one entrypoint from drifting on
 * narrow terminals or when a model/path contains wide characters.
 */
export function buildWelcomePanelRows(width: number, data: WelcomePanelData = {}): WelcomePanelRow[] {
  const safeWidth = Math.max(WELCOME_PANEL_MIN_WIDTH, Math.floor(width));
  const resolvedVersion = data.version ?? TUI_BRAND_VERSION;
  const title = `${data.title ?? TUI_BRAND_NAME}${resolvedVersion ? ` v${resolvedVersion}` : ""}`;
  const leftWidth = Math.min(40, Math.max(28, Math.floor((safeWidth - 3) * 0.32)));
  const rightWidth = Math.max(24, safeWidth - leftWidth - 3);
  const modelLine = [data.model, data.billing ?? "API Usage Billing"].filter(Boolean).join(" · ");
  const tips = [...(data.tips ?? DEFAULT_TIPS), ""].slice(0, 2);
  const updates = [...(data.updates ?? DEFAULT_UPDATES), "", ""].slice(0, 3);

  const rows: WelcomePanelRow[] = [
    { text: frameTop(safeWidth, title), kind: "border" },
    { text: frameBody(center("Welcome back!", leftWidth), right("Tips for getting started", rightWidth), leftWidth), kind: "heading" },
    { text: frameBody(center("", leftWidth), right(tips[0]!, rightWidth), leftWidth), kind: "body" },
    { text: frameBody(center(BRAND_ART[0], leftWidth), right(tips[1]!, rightWidth), leftWidth), kind: "art" },
    { text: frameBody(center(BRAND_ART[1], leftWidth), "─".repeat(rightWidth), leftWidth), kind: "art" },
    { text: frameBody(center(BRAND_ART[2], leftWidth), right("What's new", rightWidth), leftWidth), kind: "art" },
    { text: frameBody(center("", leftWidth), right(updates[0]!, rightWidth), leftWidth), kind: "body" },
    { text: frameBody(center(modelLine, leftWidth), right(updates[1]!, rightWidth), leftWidth), kind: "body" },
    { text: frameBody(center(data.cwd ?? "", leftWidth), right(updates[2]!, rightWidth), leftWidth), kind: "body" },
    { text: frameBottom(safeWidth), kind: "border" },
  ];
  return rows;
}

export function welcomePanelRenderLines(width: number, data: WelcomePanelData = {}): RenderLine[] {
  return buildWelcomePanelRows(width, data).map((row, index) => ({
    key: `header-welcome-${index}`,
    text: row.text,
    style: row.kind === "border" ? "border" : row.kind === "heading" ? "assistant" : row.kind === "art" ? "assistant" : "muted",
    tone: row.kind === "border" || row.kind === "heading" || row.kind === "art" ? "running" : undefined,
    bold: row.kind === "heading" || row.kind === "art",
    dim: row.kind === "body",
  }));
}

function frameTop(width: number, title: string): string {
  const visibleTitle = fit(title, Math.max(4, width - 6));
  return `╭─ ${visibleTitle} ${"─".repeat(Math.max(0, width - terminalStringWidth(visibleTitle) - 5))}╮`;
}

function frameBottom(width: number): string {
  return `╰${"─".repeat(Math.max(0, width - 2))}╯`;
}

function frameBody(left: string, rightColumn: string, leftWidth: number): string {
  return `│${fit(left, leftWidth)}│${rightColumn}│`;
}

function center(value: string, width: number): string {
  const visible = fit(value, width);
  const padding = Math.max(0, width - terminalStringWidth(visible));
  const left = Math.floor(padding / 2);
  return `${" ".repeat(left)}${visible}${" ".repeat(padding - left)}`;
}

function right(value: string, width: number): string {
  const available = Math.max(1, width - 1);
  const visible = fit(value, available);
  return ` ${visible}${" ".repeat(Math.max(0, available - terminalStringWidth(visible)))}`;
}

function fit(value: string, width: number): string {
  const safeWidth = Math.max(0, width);
  if (terminalStringWidth(value) <= safeWidth) return value;
  if (safeWidth <= 1) return safeWidth === 1 ? "…" : "";
  let result = "";
  let used = 0;
  for (const character of value) {
    const characterWidth = Math.max(1, terminalStringWidth(character));
    if (used + characterWidth > safeWidth - 1) break;
    result += character;
    used += characterWidth;
  }
  return `${result}…`;
}
