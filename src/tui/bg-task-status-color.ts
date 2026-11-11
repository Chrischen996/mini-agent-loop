/**
 * Shared background-task status → color resolver.
 *
 * Centralizes the color semantics used by the live background-task panel and any
 * other chrome that surfaces a `BgTaskSummary.status` string, so a failed or
 * crashed task always reads as red, a running task as amber, and a completed
 * task as green — regardless of which component renders it.
 */
import { TUI_COLORS as C } from "./theme.ts";

/** Status strings the manager emits for a live/active task. */
const ACTIVE_STATUSES = new Set(["starting", "running", "unknown"]);
/** Status strings that mean the task reached a successful end. */
const SUCCESS_STATUSES = new Set(["completed", "done"]);
/** Status strings that mean the task ended without success. */
const ERROR_STATUSES = new Set([
  "failed",
  "crashed",
  "interrupted",
  "cancelled",
  "timed_out",
]);

export function isBgTaskActive(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function isBgTaskError(status: string): boolean {
  return ERROR_STATUSES.has(status);
}

export function isBgTaskSuccess(status: string): boolean {
  return SUCCESS_STATUSES.has(status);
}

/** Resolve the foreground color for a background-task status string. */
export function bgTaskStatusColor(status: string): string {
  if (isBgTaskActive(status)) return C.running;
  if (isBgTaskSuccess(status)) return C.success;
  if (isBgTaskError(status)) return C.error;
  return C.muted;
}

/** Resolve a short, consistent glyph for a background-task status string. */
export function bgTaskStatusGlyph(status: string): string {
  if (isBgTaskActive(status)) return "⟳";
  if (isBgTaskSuccess(status)) return "✓";
  if (isBgTaskError(status)) return "✗";
  return "☐";
}

/* ------------------------------------------------------------------ *
 * Agent dashboard statuses.
 *
 * The agent dashboard reports a different vocabulary than the background
 * task manager (`Working`, `Completed`, `Needs input`, …). It shares the
 * same color and glyph semantics so both panels read identically.
 * ------------------------------------------------------------------ */

/** Agent statuses that mean the agent is actively working. */
const AGENT_ACTIVE_STATUSES = new Set(["working", "starting", "preparing", "launching", "needs input"]);
/** Agent statuses that mean the agent finished successfully. */
const AGENT_SUCCESS_STATUSES = new Set(["completed", "done"]);
/** Agent statuses that mean the agent stopped without success. */
const AGENT_ERROR_STATUSES = new Set(["failed", "crashed", "interrupted", "cancelled", "canceled", "timed_out"]);

/** Resolve the foreground color for an agent-dashboard status string. */
export function agentStatusColor(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (AGENT_ACTIVE_STATUSES.has(normalized)) return C.running;
  if (AGENT_ERROR_STATUSES.has(normalized)) return C.error;
  if (AGENT_SUCCESS_STATUSES.has(normalized)) return C.success;
  return C.muted;
}

/** Resolve a short, consistent glyph for an agent-dashboard status string. */
export function agentStatusGlyph(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (AGENT_ACTIVE_STATUSES.has(normalized)) return "⟳";
  if (AGENT_ERROR_STATUSES.has(normalized)) return "✗";
  if (AGENT_SUCCESS_STATUSES.has(normalized)) return "✓";
  return "☐";
}
