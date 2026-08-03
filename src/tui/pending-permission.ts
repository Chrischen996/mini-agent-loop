import type { Key } from "ink";
import type { PermissionDecision } from "../permissions.ts";

/**
 * Resolve a key press while a permission request is pending.
 *
 * We keep the mapping tiny and explicit so the UI can stay predictable:
 * Enter rejects by default, while A/D provide the affirmative/negative
 * choices exposed in the status hint.
 */
export function resolvePendingPermissionDecision(ch: string, key: Key): PermissionDecision | null {
  if (key.return) return "deny";
  if (ch === "a" || ch === "A") return "allow";
  if (ch === "d" || ch === "D") return "deny";
  return null;
}
