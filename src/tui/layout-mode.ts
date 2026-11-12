/**
 * Terminal layout mode for the TUI frame.
 *
 * - `inline`: the dynamic frame lives on the main screen buffer. Sealed
 *   transcript history is emitted through Ink's `<Static>` into the terminal's
 *   native scrollback, so users can scroll/search/copy the full conversation
 *   and the history survives exit. Mouse tracking stays off so the wheel
 *   scrolls the terminal natively.
 * - `alternate`: the whole UI runs in the alternate screen buffer
 *   (`ESC[?1049h`). Nothing leaks into scrollback (clean exit), and the app
 *   owns scrolling via mouse tracking + PageUp/PageDown.
 *
 * Selected once at startup via `MINI_AGENT_TUI_LAYOUT`. The safe default is
 * `alternate` (the pre-existing behavior); `inline` opts into the
 * `<Static>` scrollback pipeline. Flip the default below once the inline
 * path has burn-in.
 */
export type TuiLayoutMode = "inline" | "alternate";

export const TUI_LAYOUT_ENV = "MINI_AGENT_TUI_LAYOUT";

/** The layout used when the env override is absent or invalid. */
export const DEFAULT_TUI_LAYOUT_MODE: TuiLayoutMode = "alternate";

export function resolveTuiLayoutMode(
  env: Record<string, string | undefined> = process.env,
): TuiLayoutMode {
  const raw = env[TUI_LAYOUT_ENV]?.trim().toLowerCase();
  if (raw === "inline") return "inline";
  if (raw === "alternate" || raw === "alt") return "alternate";
  return DEFAULT_TUI_LAYOUT_MODE;
}
