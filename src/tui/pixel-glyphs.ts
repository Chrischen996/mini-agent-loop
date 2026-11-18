/**
 * 8-bit "Super Mario" glyph overrides.
 *
 * The transcript renderers read their marker glyphs from `render-lines.ts`
 * constants (`STATUS_DONE`, `RESULT_GUTTER`, ...), which are frozen at module
 * load and cannot be swapped by `applyTheme()`. This module is the one place
 * that keeps a *swappable* set: every field is optional, and a field that is
 * absent means "use the framework default".
 *
 * That shape keeps the default theme byte-identical (no glyph drift into the
 * existing snapshot/consistency tests) while letting a pixel theme re-skin the
 * status markers, the todo progress meter, the spinner and the welcome art
 * from a single `applyTheme()` call.
 *
 * This module must stay dependency-free: `theme.ts`, `loading.ts` and
 * `welcome-panel.ts` all read it, so importing anything here would create a
 * cycle.
 */
export type PixelGlyphs = {
  /** Marker for completed work (default `✓`). */
  done?: string;
  /** Marker for work in progress (default `⟳`). */
  running?: string;
  /** Marker for partially completed work (default `~`). */
  partial?: string;
  /** Marker for failures (default `✗`). */
  error?: string;
  /** Marker for queued/untouched work (default `☐`). */
  pending?: string;
  /** Marker for skipped work (default `-`). */
  skipped?: string;
  /** Filled cell of the todo progress meter (default `▰`). */
  progressFilled?: string;
  /** Empty cell of the todo progress meter (default `▱`). */
  progressEmpty?: string;
  /** Spinner frames; when absent the client keeps `CLAUDE_SPINNER_FRAMES`. */
  spinner?: readonly string[];
  /** Three welcome-panel art rows; when absent the client keeps `BRAND_ART`. */
  brandArt?: readonly string[];
};

/**
 * NES Super Mario Bros. palette cues: a spinning coin for live work, a star for
 * completion, a brick for queued work. Every glyph is single-width so row
 * geometry and truncation math stay unchanged.
 */
export const MARIO_GLYPHS: PixelGlyphs = {
  done: "★",        // star: stage cleared
  running: "◉",     // coin face-on
  partial: "◐",     // coin half-turned
  error: "✕",       // lost-life cross
  pending: "□",     // empty brick block
  skipped: "—",
  progressFilled: "◉",
  progressEmpty: "□",
  // Coin spin: face, edge, thin, edge. Four frames keep the 240ms cadence
  // reading as rotation without needing a wide glyph.
  spinner: ["◉", "◎", "○", "◎"],
  // `?` block with a star, drawn with corner/quadrant blocks.
  brandArt: [" ▛▀▀▀▀▜ ", " ▐ ★ ▌ ", " ▙▄▄▄▄▟ "],
};

/**
 * Luigi / underwater-stage variant: same pixel glyphs, cooler accents come from
 * the palette side. Shares the glyph set so the two Mario themes stay visually
 * consistent.
 */
export const MARIO_PIXEL_GLYPHS: PixelGlyphs = MARIO_GLYPHS;

/** Theme names (lowercase) that opt into a pixel glyph set. */
const PIXEL_GLYPH_SETS: Record<string, PixelGlyphs> = {
  "mario-classic": MARIO_GLYPHS,
  "mario-underwater": MARIO_PIXEL_GLYPHS,
};

let activePixelGlyphs: PixelGlyphs | null = null;

/** Swap the live glyph overrides for a theme; non-pixel themes clear them. */
export function applyPixelGlyphs(themeName: string): void {
  activePixelGlyphs = PIXEL_GLYPH_SETS[themeName.toLowerCase()] ?? null;
}

/** Current pixel overrides, or `null` when the active theme uses framework glyphs. */
export function pixelGlyphs(): PixelGlyphs | null {
  return activePixelGlyphs;
}

export function isPixelTheme(): boolean {
  return activePixelGlyphs !== null;
}

/**
 * Ink border character set. Ink's `borderStyle` accepts either a preset name
 * (`"round"`, `"single"`, ...) or a custom eight-glyph object (cli-boxes
 * `BoxStyle`); geometry stays with Yoga's layout engine, so swapping the
 * characters never changes row/column budgets.
 */
export type PanelBorder = {
  topLeft: string;
  top: string;
  topRight: string;
  right: string;
  bottomRight: string;
  bottom: string;
  bottomLeft: string;
  left: string;
};

const MARIO_BORDER: PanelBorder = {
  topLeft: "▛", top: "▀", topRight: "▜",
  right: "▐", bottomRight: "▟", bottom: "▄",
  bottomLeft: "▙", left: "▌",
};

/** For Ink `Box`'s borderStyle: pixel themes get the block set, otherwise the preset name. */
export function panelBorderStyle(fallback: "round" | "single" = "round"): "round" | "single" | PanelBorder {
  return activePixelGlyphs ? MARIO_BORDER : fallback;
}

/**
 * Headless (ANSI projection) panel border characters. The width-undefined
 * branch prefixes (`╭─ `, `│  `, `╰─ `) must keep display width 3, and all
 * glyphs above are single-width, so downstream indentation and row-width
 * math stay unchanged when the pixel theme is active.
 */
export type PanelBorderGlyphs = {
  /** Top-left corner (default `╭`). */
  topCorner: string;
  /** Top border / caption dash (default `─`). */
  topMid: string;
  /** Top-right corner (default `╮`). */
  topRightCorner: string;
  /** Left wall (default `│`). */
  side: string;
  /** Right wall (default `│`). */
  sideEnd: string;
  /** Bottom-left corner (default `╰`). */
  bottomCorner: string;
  /** Bottom border (default `─`). */
  bottomMid: string;
  /** Bottom-right corner (default `╯`). */
  bottomRightCorner: string;
};

const DEFAULT_PANEL_BORDER_GLYPHS: PanelBorderGlyphs = {
  topCorner: "╭", topMid: "─", topRightCorner: "╮",
  side: "│", sideEnd: "│",
  bottomCorner: "╰", bottomMid: "─", bottomRightCorner: "╯",
};

const MARIO_PANEL_BORDER_GLYPHS: PanelBorderGlyphs = {
  topCorner: MARIO_BORDER.topLeft, topMid: MARIO_BORDER.top, topRightCorner: MARIO_BORDER.topRight,
  side: MARIO_BORDER.left, sideEnd: MARIO_BORDER.right,
  bottomCorner: MARIO_BORDER.bottomLeft, bottomMid: MARIO_BORDER.bottom, bottomRightCorner: MARIO_BORDER.bottomRight,
};

/** Live headless border glyphs for the active theme (framework borders by default). */
export function panelBorderGlyphs(): PanelBorderGlyphs {
  return activePixelGlyphs ? MARIO_PANEL_BORDER_GLYPHS : DEFAULT_PANEL_BORDER_GLYPHS;
}
