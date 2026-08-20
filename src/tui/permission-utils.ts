import {
  PERMISSION_MODES,
  type PermissionManager,
  type PermissionMode,
  type PermissionModeChangedError,
} from "../permissions.ts";

/**
 * Switch permission mode and return true if changed.
 */
export function switchPermissionMode(
  manager: PermissionManager,
  mode: PermissionMode,
): boolean {
  const current = manager.getMode();
  if (current === mode) return false;
  manager.setMode(mode);
  return true;
}

/**
 * Get the next permission mode in circular order.
 */
export function nextPermissionMode(current: PermissionMode): PermissionMode {
  const idx = PERMISSION_MODES.indexOf(current);
  return PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length] ?? "plan";
}

/**
 * Build the permission-mode-changed abort event payload.
 */
export function permissionChangedAbortPayload(
  reason: unknown,
): { type: "aborted"; reason: "permission_mode_changed"; previousMode: PermissionMode; permissionMode: PermissionMode } | null {
  if (!(reason instanceof Error) || reason.name !== "AbortError" || !("previousMode" in reason)) {
    return null;
  }
  const err = reason as PermissionModeChangedError;
  return {
    type: "aborted" as const,
    reason: "permission_mode_changed" as const,
    previousMode: err.previousMode,
    permissionMode: err.mode,
  };
}
