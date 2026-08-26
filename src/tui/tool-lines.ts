import type { ToolState } from "./state.ts";

export function toolStatusIcon(status: ToolState): string {
  if (status === "running") return "…";
  return status === "error" ? "✗" : "✓";
}

export function toolDisplayName(name: string): string {
  const normalized = name.trim();
  return normalized || "tool";
}

export function toolSummary(name: string, status: ToolState, durationMs?: number): string {
  const duration = durationMs === undefined ? "" : ` (${durationMs}ms)`;
  return `${toolStatusIcon(status)} ${toolDisplayName(name)}${duration}`;
}

