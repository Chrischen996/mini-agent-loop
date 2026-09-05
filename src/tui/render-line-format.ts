import type { RenderLine } from "./render-lines.ts";
import { terminalStringWidth } from "./terminal-width.ts";
import { TUI_COLORS as C } from "./theme.ts";

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
  codes.push(hexToAnsi(color));
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
    const base = `\x1b[${codes.join(";")}m`;
    const pointerColor = hexToAnsi(line.prefixTone === undefined ? C.muted : renderLineColor({ ...line, tone: line.prefixTone }));
    let out = `${indent}${strike}${base}`;
    if (prefix) out += `\x1b[${pointerColor}m${prefix}`;
    for (const segment of line.segments) {
      const segmentCodes: Array<number | string> = [];
      if (segment.bold) segmentCodes.push(1);
      if (segment.italic) segmentCodes.push(3);
      if (segment.dim) segmentCodes.push(2);
      segmentCodes.push(hexToAnsi(segment.color ?? color));
      if (line.background) segmentCodes.push(...backgroundCodes(line.background));
      out += `\x1b[${segmentCodes.join(";")}m${segment.text}`;
    }
    return `${out}${fill}\x1b[0m`;
  }

  // Keep the activity marker independent from the body. Claude Code uses a
  // quiet gutter/pointer even when a live operation is highlighted in amber.
  if (prefix && (line.prefixTone !== undefined || line.style === "user")) {
    const bodyColor = hexToAnsi(line.style === "user" ? C.assistant : color);
    const pointerColor = hexToAnsi(line.prefixTone === undefined ? C.muted : renderLineColor({ ...line, tone: line.prefixTone }));
    return `${indent}${strike}\x1b[${codes.join(";")}m\x1b[${pointerColor}m${prefix}\x1b[${bodyColor}m${line.text}${fill}\x1b[0m`;
  }
  return `${indent}${strike}\x1b[${codes.join(";")}m${visible}${fill}\x1b[0m`;
}

function backgroundCodes(background: NonNullable<RenderLine["background"]>): number[] {
  const value = background === "user" ? "48;5;236" : background === "selection" ? "48;5;24" : "48;5;178";
  return value.split(";").map(Number);
}

function renderLineColor(line: Pick<RenderLine, "style" | "tone">): string {
  return line.tone === "success" ? C.success
    : line.tone === "running" ? C.running
      : line.tone === "error" || line.style === "error" ? C.error
        : line.style === "thinking" ? C.thinking
          : line.style === "tool" ? C.info
            : line.style === "todo" ? C.info
              : line.style === "user" ? C.user
                : line.style === "border" || line.style === "muted" ? C.muted
                  : C.assistant;
}

function hexToAnsi(hex: string): string {
  const value = hex.replace(/^#/, "");
  if (value.length !== 6) return "38;5;7";
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `38;2;${red};${green};${blue}`;
}
