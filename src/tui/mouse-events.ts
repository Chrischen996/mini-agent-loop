export type MouseWheelDirection = "up" | "down";

/** Return the wheel direction for an SGR mouse event, if it is a wheel event. */
export function parseSgrMouseWheel(data: string): MouseWheelDirection | undefined {
  const match = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
  if (!match) return undefined;
  const button = Number.parseInt(match[1]!, 10);
  if (button === 64) return "up";
  if (button === 65) return "down";
  return undefined;
}

/**
 * Recognize a complete SGR mouse report so it cannot leak into text input.
 * Accepts both the raw form (\x1b[<...M) and the ESC-stripped form that
 * Ink's useInput passes to handlers ([<...M).
 */
export function isSgrMouseEvent(data: string): boolean {
  return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) || /^\[<\d+;\d+;\d+[Mm]$/.test(data);
}

/**
 * Return the wheel direction for an X10/URXVT (non-SGR) mouse report.
 *
 * Terminals that enable plain mouse tracking (?1000h) but do not support SGR
 * coordinates (?1006h) — e.g. `screen`, older `tmux`, some serial consoles —
 * report the wheel as `ESC [ M Cb` (one coordinate char) or
 * `ESC [ M Cb Cr Cc` (button-extended modes). The button code is offset by
 * +32: '`' (96) is wheel up, 'a' (97) is wheel down.
 *
 * Accepts both the raw form and the ESC-stripped form that Ink's useInput
 * passes to handlers.
 */
export function parseX10MouseWheel(data: string): MouseWheelDirection | undefined {
  const match = /^\x1b?\[M(.{1,3})$/.exec(data);
  if (!match) return undefined;
  const buttonChar = match[1]!.slice(-1);
  if (buttonChar === "`") return "up";
  if (buttonChar === "a") return "down";
  return undefined;
}

/** Recognize a complete X10/URXVT mouse report so it cannot leak into text input. */
export function isX10MouseEvent(data: string): boolean {
  return /^\x1b?\[M[\x20-\xff]{1,3}$/.test(data);
}

/** Return the wheel direction for any recognized mouse report (SGR or X10). */
export function parseMouseWheel(data: string): MouseWheelDirection | undefined {
  return parseSgrMouseWheel(data) ?? parseX10MouseWheel(data);
}

/** Recognize a complete mouse report (SGR or X10) so it cannot leak into text input. */
export function isMouseEvent(data: string): boolean {
  return isSgrMouseEvent(data) || isX10MouseEvent(data);
}

/**
 * Recognize a complete Kitty keyboard-protocol key report so it cannot leak
 * into text input: `ESC [ <keycode>[;<mods>]u` (raw) or `[<keycode>[;<mods>]u`
 * (ESC-stripped form passed by Ink's useInput).
 */
export function isKittyProtocolKey(data: string): boolean {
  return /^\x1b\[\d+(?:;\d+)?u$/.test(data) || /^\[\d+(?:;\d+)?u$/.test(data);
}
