import type { PermissionMode } from "../permissions.ts";
import { TUI_COLORS as C } from "./theme.ts";

export function useClaudeStyleInput(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TUI_CLAUDE_STYLE_INPUT === "1";
}

export function inputContainerBorderColor(input: {
  permissionMode: PermissionMode;
  busy: boolean;
  pendingPermission: boolean;
}): string {
  if (input.pendingPermission) return C.error;
  if (input.busy) return C.running;
  if (input.permissionMode === "plan") return C.planMode;
  return C.border;
}
