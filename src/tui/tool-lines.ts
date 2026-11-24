import type { ToolState } from "./state.ts";
import { pixelGlyphs } from "./pixel-glyphs.ts";
import { STATUS_DONE, STATUS_ERROR, STATUS_PARTIAL, STATUS_RUNNING } from "./render-lines.ts";

export function toolStatusIcon(status: ToolState): string {
  const pixel = pixelGlyphs();
  if (status === "running") return pixel?.running ?? STATUS_RUNNING;
  if (status === "partial") return pixel?.partial ?? STATUS_PARTIAL;
  return status === "error"
    ? (pixel?.error ?? STATUS_ERROR)
    : (pixel?.done ?? STATUS_DONE);
}

export function toolDisplayName(name: string): string {
  const normalized = name.trim();
  return normalized || "tool";
}

/** Presentation-only labels; the normalized tool API remains lowercase/stable. */
export function toolVisualName(name: string): string {
  const normalized = toolDisplayName(name);
  const labels: Record<string, string> = {
    read: "Read",
    bash: "Bash",
    write: "Write",
    edit: "Edit",
    grep: "Grep",
    search: "Search",
    find: "Glob",
    ls: "List",
    list: "List",
    delete: "Delete",
    bg_start: "BgStart",
    bg_status: "BgStatus",
    bg_logs: "BgLogs",
    bg_send: "BgSend",
    bg_wait: "BgWait",
    bg_kill: "BgKill",
    git_diff: "GitDiff",
    // Without this label the transcript row shows the raw snake_case name
    // right next to a nicely formatted confirmation card.
    request_permission_mode: "RequestMode",
  };
  return labels[normalized.toLowerCase()] ?? normalized;
}

export function toolVisualStatusIcon(status: ToolState): string {
  return toolStatusIcon(status);
}

/** Keep multi-line tool results on one fixed tree gutter column. */
export function toolSummary(name: string, status: ToolState, durationMs?: number): string {
  const duration = durationMs === undefined ? "" : ` (${durationMs}ms)`;
  return `${toolStatusIcon(status)} ${toolDisplayName(name)}${duration}`;
}
