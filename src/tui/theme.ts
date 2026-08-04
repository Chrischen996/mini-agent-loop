/**
 * Shared terminal colors for the active Ink TUI.
 *
 * These are deliberately low-saturation truecolor values. Terminals without
 * truecolor support will downgrade them to their nearest ANSI color.
 */
export const TUI_COLORS = {
  primary: "#e8b86a",      // warm brass for titles and primary navigation
  info: "#8fc5d3",         // mist blue for models, paths, and values
  user: "#9bc7a5",         // sage for user prompt and input cursor
  assistant: "#e7e9ec",    // soft white for readable response text
  muted: "#8b949e",        // neutral gray for metadata and hints
  border: "#4b5563",       // quiet neutral panel borders
  selection: "#77a9d6",    // restrained blue for active row/focus
  thinking: "#b9a1d2",     // muted lilac for reasoning
  running: "#e8b86a",      // brass for in-progress work
  success: "#9bc7a5",      // sage for completed work
  error: "#df8790",        // muted coral for errors and rejected actions
  badgeText: "#1c2126",    // readable text on status badges
} as const;
