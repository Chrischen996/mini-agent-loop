import type { RenderLine } from "./render-lines.ts";
import { terminalStringWidth } from "./terminal-width.ts";
import { TUI_COLORS as C, activeThemeName } from "./theme.ts";

/** Resolve a row's foreground color. Shared by Ink and ANSI renderers. */
export function renderLineColor(line: Pick<RenderLine, "style" | "tone">): string {
  return line.tone === "success" ? C.success
    : line.tone === "running" ? C.running
      : line.tone === "error" || line.style === "error" ? C.error
        : line.style === "thinking" ? C.thinking
          : line.style === "tool" || line.style === "todo" ? C.info
            : line.style === "user" ? C.user
              : line.style === "border" || line.style === "muted" ? C.muted
                : C.assistant;
}

/** Convert one shared render row into terminal ANSI without moving the cursor. */
export function formatRenderLine(line: RenderLine): string {
  const indent = " ".repeat(Math.max(0, line.indent ?? 0));
  const codes: Array<number | string> = [];
  if (line.bold) codes.push(1);
  if (line.italic) codes.push(3);
  if (line.dim) codes.push(2);
  // Keep strike-through as its own CSI sequence for compatibility with the
  // legacy renderer's output and terminals that reset it independently.
  const strike = line.strikethrough ? "\x1b[9m" : "";
  const color = renderLineColor(line);
  if (color) codes.push(hexToAnsi(color));
  if (line.background) codes.push(...backgroundCodes(line.background));
  const prefix = line.prefix ?? "";
  const body = line.segments?.length
    ? line.segments.map((segment) => segment.text).join("")
    : line.text;
  const visible = `${prefix}${body}`;
  const fill = line.fillWidth === undefined
    ? ""
    : " ".repeat(Math.max(0, line.fillWidth - terminalStringWidth(indent + visible)));

  // Chrome rows carry several colors on one physical row (the status line is
  // the main case). Each segment resets only the attributes it owns so the
  // row-level background and strike-through survive.
  if (line.segments?.length) {
    const base = codes.length ? `\x1b[${codes.join(";")}m` : "";
    const pointerBase = line.prefixBold && !line.bold ? `\x1b[${[...codes, 1].join(";")}m` : base;
    const pointerColor = hexToAnsi(line.prefixTone === undefined ? C.muted : renderLineColor({ ...line, tone: line.prefixTone }));
    let out = `${indent}${strike}${base}`;
    if (prefix) out += pointerColor ? `${pointerBase}\x1b[${pointerColor}m${prefix}` : prefix;
    for (const segment of line.segments) {
      const segmentCodes: Array<number | string> = [];
      if (segment.bold) segmentCodes.push(1);
      if (segment.italic) segmentCodes.push(3);
      if (segment.dim) segmentCodes.push(2);
      const segmentColor = hexToAnsi(segment.color ?? color);
      if (segmentColor) segmentCodes.push(segmentColor);
      if (line.background) segmentCodes.push(...backgroundCodes(line.background));
      const segBase = segmentCodes.length ? `\x1b[${segmentCodes.join(";")}m` : "";
      out += `${segBase}${segment.text}`;
    }
    return `${out}${fill}\x1b[0m`;
  }

  // Keep the activity marker independent from the body. Claude Code uses a
  // quiet gutter/pointer even when a live operation is highlighted in amber.
  if (prefix && (line.prefixTone !== undefined || line.style === "user")) {
    const bodyColor = hexToAnsi(line.style === "user" ? C.assistant : color);
    const pointerColor = hexToAnsi(line.prefixTone === undefined ? C.muted : renderLineColor({ ...line, tone: line.prefixTone }));
    const pointerCodes = line.prefixBold && !line.bold ? [...codes, 1] : codes;
    const pointerBase = pointerCodes.length ? `\x1b[${pointerCodes.join(";")}m` : "";
    const bodyBase = codes.length ? `\x1b[${codes.join(";")}m` : "";
    const pointer = pointerColor ? `${pointerBase}\x1b[${pointerColor}m${prefix}` : `${pointerBase}${prefix}`;
    const body = bodyColor ? `${bodyBase}\x1b[${bodyColor}m${line.text}` : `${bodyBase}${line.text}`;
    return `${indent}${strike}${pointer}${body}${fill}\x1b[0m`;
  }
  const rowBase = codes.length ? `\x1b[${codes.join(";")}m` : "";
  return `${indent}${strike}${rowBase}${visible}${fill}\x1b[0m`;
}

function backgroundCodes(background: NonNullable<RenderLine["background"]>): number[] {
  // The default Claude palette keeps its original 256-color background codes
  // (renderer tests and muscle memory depend on them). Every other theme
  // resolves the slot through the live palette.
  if (activeThemeName() === "claude-dark") {
    const legacy = background === "user" ? "48;5;236" : background === "selection" ? "48;5;24" : "48;5;178";
    return legacy.split(";").map(Number);
  }
  const value = background === "user" ? C.userBg : background === "selection" ? C.selection : C.running;
  return toBackgroundCodes(value);
}

function toBackgroundCodes(color: string): number[] {
  if (!color) return [];
  const fg = ANSI_FOREGROUND_CODES[color.toLowerCase()];
  if (fg) return [Number(fg) + 10]; // 30-37/90-97 foreground codes map to 40-47/100-107 backgrounds
  const value = expandHex(color);
  if (!value) return [];
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return [48, 2, red, green, blue];
}

/** Normalize "#rgb"/"#rrggbb"/plain hex to six hex digits; null otherwise. */
function expandHex(color: string): string | null {
  const value = color.replace(/^#/, "");
  if (value.length === 3) return value.split("").map((c) => c + c).join("");
  return value.length === 6 ? value : null;
}

/** Basic-16 ANSI foreground SGR codes, keyed by chalk/Ink color names. */
const ANSI_FOREGROUND_CODES: Record<string, string> = {
  black: "30", red: "31", green: "32", yellow: "33", blue: "34", magenta: "35", cyan: "36", white: "37",
  gray: "90", grey: "90", blackbright: "90", brightblack: "90",
  redbright: "91", brightred: "91", greenbright: "92", brightgreen: "92",
  yellowbright: "93", brightyellow: "93", bluebright: "94", brightblue: "94",
  magentabright: "95", brightmagenta: "95", cyanbright: "96", brightcyan: "96",
  whitebright: "97", brightwhite: "97",
};

/** Convert a palette color (hex or basic ANSI name) to an SGR parameter.
 *  Empty strings (no-color themes) return "" so callers skip the sequence. */
export function hexToAnsi(hex: string): string {
  if (!hex) return "";
  const named = ANSI_FOREGROUND_CODES[hex.toLowerCase()];
  if (named) return named;
  const value = expandHex(hex);
  if (!value) return "38;5;7";
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `38;2;${red};${green};${blue}`;
}
