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
  if (line.background) {
    const background = line.background === "user" ? "48;5;236" : line.background === "selection" ? "48;5;24" : "48;5;178";
    codes.push(...background.split(";").map(Number));
  }
  const prefix = line.prefix ?? "";
  const visible = `${prefix}${line.text}`;
  const fill = line.fillWidth === undefined
    ? ""
    : " ".repeat(Math.max(0, line.fillWidth - terminalStringWidth(indent + visible)));

  // Keep the activity marker independent from the body. Claude Code uses a
  // quiet gutter/pointer even when a live operation is highlighted in amber.
  if (prefix && (line.prefixTone !== undefined || line.style === "user")) {
    const bodyColor = hexToAnsi(line.style === "user" ? C.assistant : color);
    const pointerColor = hexToAnsi(line.prefixTone === undefined ? C.muted : renderLineColor({ ...line, tone: line.prefixTone }));
    return `${indent}${strike}\x1b[${codes.join(";")}m\x1b[${pointerColor}m${prefix}\x1b[${bodyColor}m${line.text}${fill}\x1b[0m`;
  }
  return `${indent}${strike}\x1b[${codes.join(";")}m${visible}${fill}\x1b[0m`;
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
