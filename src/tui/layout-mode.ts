/**
 * Terminal layout mode for the TUI frame.
 *
 * - `document` (default): full document-flow (aider / Codex-insert style) —
 *   nothing is pinned. Completed streaming lines append into the terminal
 *   stream as their newlines arrive (only open tables wait), the dynamic
 *   frame is just the growing tail + composer, and the whole conversation —
 *   input box included — scrolls as one continuous document. No clipping
 *   hints.
 * - `inline`: the transcript grows into the terminal's native scrollback at
 *   MESSAGE granularity: sealed history (user / assistant / notice / error /
 *   completed tool_call; subagent cards stay dynamic) is emitted via the
 *   renderer's `emitStaticBurst`; the live tail renders inside the frame.
 *   Choose with `MINI_AGENT_TUI_LAYOUT=inline`.
 * - `alternate`: the whole UI runs in the alternate screen buffer
 *   (`ESC[?1049h`). Nothing leaks into scrollback (clean exit), and the app
 *   owns scrolling via mouse tracking + PageUp/PageDown. Roll back to the
 *   pre-static-split behavior with `MINI_AGENT_TUI_LAYOUT=alternate`.
 *
 * Selected once at startup via `MINI_AGENT_TUI_LAYOUT`.
 */
export type TuiLayoutMode = "inline" | "alternate" | "document";

export const TUI_LAYOUT_ENV = "MINI_AGENT_TUI_LAYOUT";

/** The layout used when the env override is absent or invalid. */
export const DEFAULT_TUI_LAYOUT_MODE: TuiLayoutMode = "document";

export function resolveTuiLayoutMode(
  env: Record<string, string | undefined> = process.env,
): TuiLayoutMode {
  const raw = env[TUI_LAYOUT_ENV]?.trim().toLowerCase();
  if (raw === "inline") return "inline";
  if (raw === "alternate" || raw === "alt") return "alternate";
  if (raw === "document" || raw === "doc" || raw === "flow" || raw === "insert") return "document";
  return DEFAULT_TUI_LAYOUT_MODE;
}
