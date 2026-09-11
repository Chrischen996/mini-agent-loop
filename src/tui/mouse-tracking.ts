const ENABLE_MOUSE_TRACKING = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE_TRACKING = "\x1b[?1006l\x1b[?1000l";

type WritableTerminal = { write(value: string): unknown };

/** Enable button tracking plus SGR coordinates for wheel events. */
export function enableMouseTracking(target: WritableTerminal): void {
  target.write(ENABLE_MOUSE_TRACKING);
}

/** Restore terminal mouse handling before returning to the user's shell. */
export function disableMouseTracking(target: WritableTerminal): void {
  target.write(DISABLE_MOUSE_TRACKING);
}
