import type { PermissionMode } from "../permissions.ts";

/** Native key shape — no Ink dependency so the mapping stays testable. */
type Key = { escape?: boolean; return?: boolean; ctrl?: boolean; shift?: boolean };

export type ModeRequestDecision = "switch" | "dismiss";

/**
 * Resolve a key press while the model's permission-mode request is pending.
 *
 * Same muscle memory as the permission card: `A` accepts, `D`/Enter/Esc keep
 * the current mode. Enter is deliberately the conservative choice so a stray
 * newline can never grant write/exec authority.
 */
export function resolveModeRequestDecision(ch: string, key: Key): ModeRequestDecision | null {
  if (key.escape) return "dismiss";
  if (key.return) return "dismiss";
  if (ch === "a" || ch === "A") return "switch";
  if (ch === "d" || ch === "D") return "dismiss";
  return null;
}

/** Prompt sent on the follow-up turn after the user accepts a mode switch. */
export function modeRequestContinuationPrompt(mode: PermissionMode): string {
  return mode === "bypass"
    ? "Permission mode is now bypass. Continue the task from where you stopped."
    : "Permission mode is now plan. Continue with read-only analysis.";
}

/** Short human label for the requested mode, used by the card and notices. */
export function modeRequestLabel(mode: PermissionMode): string {
  return mode === "bypass" ? "bypass (execute writes and shell)" : "plan (read-only analysis)";
}
