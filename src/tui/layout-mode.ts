/**
 * Terminal layout mode for the TUI frame.
 *
 * - `inline` (default): the dynamic frame lives on the main screen buffer.
 *   Sealed transcript history is emitted directly into the terminal's native
 *   scrollback (renderer `emitStaticBurst`), so users can scroll/search/copy
 *   the full conversation and the history survives exit. Mouse tracking stays
 *   off so the wheel scrolls the terminal natively.
 * - `alternate`: the whole UI runs in the alternate screen buffer
 *   (`ESC[?1049h`). Nothing leaks into scrollback (clean exit), and the app
 *   owns scrolling via mouse tracking + PageUp/PageDown. Roll back to the
 *   pre-static-split behavior with `MINI_AGENT_TUI_LAYOUT=alternate`.
 * - `document`: full document-flow (aider / Codex-insert style) — nothing is
 *   pinned. Streaming paragraphs append into the stream as they close and
 *   the dynamic frame is only the live tail + composer, so scrolling the
 *   terminal moves the ENTIRE conversation (input box included) together.
 *   Opt-in via `MINI_AGENT_TUI_LAYOUT=document`.
 *
 * Selected once at startup via `MINI_AGENT_TUI_LAYOUT`.
 */
export type TuiLayoutMode = "inline" | "alternate" | "document";

export const TUI_LAYOUT_ENV = "MINI_AGENT_TUI_LAYOUT";

/** The layout used when the env override is absent or invalid. */
export const DEFAULT_TUI_LAYOUT_MODE: TuiLayoutMode = "inline";

export function resolveTuiLayoutMode(
  env: Record<string, string | undefined> = process.env,
): TuiLayoutMode {
  const raw = env[TUI_LAYOUT_ENV]?.trim().toLowerCase();
  if (raw === "inline") return "inline";
  if (raw === "alternate" || raw === "alt") return "alternate";
  if (raw === "document" || raw === "doc" || raw === "flow" || raw === "insert") return "document";
  return DEFAULT_TUI_LAYOUT_MODE;
}
