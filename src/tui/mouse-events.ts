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
