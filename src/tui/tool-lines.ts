import type { ToolState } from "./state.ts";

export function toolStatusIcon(status: ToolState): string {
  if (status === "running") return "…";
  return status === "error" ? "✗" : "✓";
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
  };
  return labels[normalized.toLowerCase()] ?? normalized;
}

export function toolVisualStatusIcon(status: ToolState): string {
  if (status === "running") return "⟳";
  return status === "error" ? "✗" : "✓";
}

export function toolSummary(name: string, status: ToolState, durationMs?: number): string {
  const duration = durationMs === undefined ? "" : ` (${durationMs}ms)`;
  return `${toolStatusIcon(status)} ${toolDisplayName(name)}${duration}`;
}
