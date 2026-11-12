import { splitGraphemes } from "./input-editing.ts";

const ANSI_RE = /\u001B\[[0-?]*[ -/]*[@-~]/g;

/** Longest emoji ZWJ families / flag sequences are still well under this. */
const MAX_GRAPHEME_WIDTH = 8;

function isCombining(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    codePoint === 0xfe0f ||
    codePoint === 0x200d
  );
}

function isWide(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  );
}

/**
 * Grapheme widths repeat heavily across frames (CJK text, emoji, status
 * glyphs), and every painted row re-measures its content through
 * `truncateTerminalText`. Memoize per grapheme so the expensive scan (ZWJ
 * families, wide-range checks) runs once per distinct glyph per session.
 */
const GRAPHEME_WIDTH_CACHE_CAP = 8192;
const graphemeWidthCache = new Map<string, number>();

export function graphemeWidth(grapheme: string): number {
  const cached = graphemeWidthCache.get(grapheme);
  if (cached !== undefined) return cached;
  const width = computeGraphemeWidth(grapheme);
  if (graphemeWidthCache.size >= GRAPHEME_WIDTH_CACHE_CAP) graphemeWidthCache.clear();
  graphemeWidthCache.set(grapheme, width);
  return width;
}

function computeGraphemeWidth(grapheme: string): number {
  let width = 0;
  let sawBase = false;
  let afterJoiner = false;
  for (const character of grapheme) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) continue;
    if (isCombining(codePoint)) {
      afterJoiner = codePoint === 0x200d;
      continue;
    }
    const wide = isWide(codePoint);
    if (sawBase && afterJoiner) {
      // ZWJ families ("👨‍👩‍👧‍👦") chain bases with U+200D: every joined base
      // belongs to the same on-screen glyph, so add at most one column instead
      // of summing every member and breaking row math for long families.
      width = Math.min(MAX_GRAPHEME_WIDTH, width + 1);
    } else if (!sawBase) {
      width = wide ? 2 : 1;
    }
    sawBase = true;
    afterJoiner = false;
  }
  return width;
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

/**
 * Memoized full-line widths. Diff/truncate/layout repeatedly measure the exact
 * same row strings (cached transcript rows are re-checked every frame), so the
 * ANSI strip + grapheme scan only needs to run once per distinct string.
 * Keys include ANSI sequences, so styled and plain variants cache separately.
 */
const LINE_WIDTH_CACHE_CAP = 16384;
const lineWidthCache = new Map<string, number>();

export function terminalStringWidth(value: string): number {
  const cached = lineWidthCache.get(value);
  if (cached !== undefined) return cached;
  let width = 0;
  for (const grapheme of splitGraphemes(stripAnsi(value))) {
    width += graphemeWidth(grapheme);
  }
  if (lineWidthCache.size >= LINE_WIDTH_CACHE_CAP) lineWidthCache.clear();
  lineWidthCache.set(value, width);
  return width;
}

/** Test/diagnostic hook: drop both width caches. */
export function clearTerminalWidthCaches(): void {
  graphemeWidthCache.clear();
  lineWidthCache.clear();
}

export function countTerminalRows(value: string, columns: number): number {
  if (!value) return 0;
  const safeColumns = Math.max(1, columns);
  return value.split("\n").reduce((rows, line) => {
    return rows + Math.max(1, Math.ceil(terminalStringWidth(line) / safeColumns));
  }, 0);
}

/**
 * Split one logical line into the physical rows a terminal shows it as.
 *
 * `firstColumn` is consumed by the first row only (gutter prefixes, list
 * markers); continuation rows start at `continuationColumn` so hanging indents
 * can be preserved. Pure grapheme wrapping — no word boundaries — to match
 * Ink's hard `wrap="wrap"` used across the message feed.
 */
export function wrapTerminalLine(
  line: string,
  columns: number,
  options: { firstColumn?: number; continuationColumn?: number } = {},
): string[] {
  const budget = Math.max(1, columns);
  const firstColumn = Math.max(0, Math.min(options.firstColumn ?? 0, budget));
  const continuationColumn = Math.max(0, Math.min(options.continuationColumn ?? 0, budget));
  if (!line) return [""];
  const rows: string[] = [];
  let current = "";
  let used = firstColumn;
  for (const grapheme of splitGraphemes(line)) {
    const glyphWidth = graphemeWidth(grapheme);
    if (used + glyphWidth > budget && current) {
      rows.push(current);
      current = "";
      used = continuationColumn;
    }
    current += grapheme;
    used += Math.max(0, glyphWidth);
  }
  rows.push(current);
  return rows;
}

/**
 * Truncate a styled string to `maxWidth` cells without splitting grapheme
 * clusters or ANSI sequences; an ellipsis marks the cut. Control characters
 * are dropped. Used by terminal-facing projections that must guarantee a row
 * can never exceed the physical column budget.
 */
export function truncateTerminalText(value: string, maxWidth: number): string {
  const budget = Math.max(0, maxWidth);
  if (terminalStringWidth(value) <= budget) return value;
  if (budget === 0) return "";
  // Fast path for unstyled input: slice graphemes directly.
  if (!value.includes("\u001b")) {
    let out = "";
    let used = 0;
    for (const grapheme of splitGraphemes(value)) {
      const glyphWidth = graphemeWidth(grapheme);
      if (used + glyphWidth > budget - 1) break;
      out += grapheme;
      used += glyphWidth;
    }
    return `${out}…`;
  }
  // Styled path: walk ANSI sequences and graphemes; styles stay open because
  // the row renderer closes every physical row it paints.
  let out = "";
  let used = 0;
  let index = 0;
  while (index < value.length) {
    const rest = value.slice(index);
    const ansiMatch = /^\u001B\[[0-?]*[ -/]*[@-~]/.exec(rest);
    if (ansiMatch) {
      out += ansiMatch[0];
      index += ansiMatch[0].length;
      continue;
    }
    const grapheme = splitGraphemes(rest)[0] ?? rest[0]!;
    const glyphWidth = graphemeWidth(grapheme);
    if (glyphWidth > 0 && used + glyphWidth > budget - 1) break;
    out += grapheme;
    index += grapheme.length;
    used += Math.max(0, glyphWidth);
  }
  return `${out}…`;
}

/**
 * Keep a useful directory suffix when a status row is narrower than cwd.
 * Generic tail truncation often starts in the middle of a path segment (for
 * example `…s/project`), while Claude Code keeps the final folder visible.
 */
export function truncateTerminalPath(value: string, maxWidth: number): string {
  const safeWidth = Math.max(1, maxWidth);
  if (terminalStringWidth(value) <= safeWidth) return value;
  if (safeWidth === 1) return "…";

  const separator = value.includes("\\") && !value.includes("/") ? "\\" : "/";
  const segments = value.split(/[\\/]+/).filter(Boolean);

  // Walk whole segments from the end. Only when the final segment itself does
  // not fit does the fallback cut inside it, so the visible suffix never starts
  // with a fragment such as `…p/mini-agent`.
  let suffix = "";
  for (let index = segments.length - 1; index >= 0; index--) {
    const candidate = suffix ? `${segments[index]}${separator}${suffix}` : segments[index]!;
    if (terminalStringWidth(`…${separator}${candidate}`) > safeWidth) break;
    suffix = candidate;
  }
  if (suffix) return `…${separator}${suffix}`;

  const last = segments[segments.length - 1] ?? value;
  let tail = "";
  let used = 0;
  for (const grapheme of [...splitGraphemes(last)].reverse()) {
    const glyphWidth = Math.max(1, graphemeWidth(grapheme));
    if (used + glyphWidth > safeWidth - 1) break;
    tail = grapheme + tail;
    used += glyphWidth;
  }
  return `…${tail}`;
}
