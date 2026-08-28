/**
 * Shared terminal colors for the active Ink TUI.
 *
 * These are deliberately low-saturation truecolor values. Terminals without
 * truecolor support will downgrade them to their nearest ANSI color.
 */
export const TUI_COLORS = {
  primary: "#d77757",      // Claude orange for assistant identity and headings
  info: "#b1b9f9",         // light blue-purple for models and paths
  user: "#7ab4e8",         // muted blue for user prompts and input
  assistant: "#ffffff",    // white for readable response text
  muted: "#999999",        // neutral gray for metadata and hints
  border: "#505050",       // quiet neutral panel borders
  selection: "#264f78",    // classic dark-mode selection blue
  thinking: "#af87ff",     // electric violet for reasoning
  running: "#ffc107",      // amber for in-progress work
  success: "#4eba65",      // bright green for completed work
  error: "#ff6b80",        // bright red for errors and rejected actions
  badgeText: "#000000",    // readable text on status badges
  userBg: "#373737",       // gray user message background (Claude Code style)
  gutter: "#505050",       // dim gray for message gutter (⎿ marker)
} as const;
