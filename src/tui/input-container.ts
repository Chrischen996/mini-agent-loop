import type { PermissionMode } from "../permissions.ts";
import { TUI_COLORS as C } from "./theme.ts";

/**
 * The Claude-style bordered input container is enabled by default; set
 * `TUI_CLAUDE_STYLE_INPUT=0` to fall back to the borderless prompt row.
 */
export function useClaudeStyleInput(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TUI_CLAUDE_STYLE_INPUT !== "0";
}

/**
 * Narrowest terminal that still has room for the bordered input container.
 *
 * Below this width the border and its padding consume the whole text area,
 * so the prompt falls back to the borderless row.
 */
export const MIN_INPUT_BORDER_WIDTH = 20;

/** Whether the bordered input container fits in this terminal width. */
export function usesInputBorder(columns: number, env: NodeJS.ProcessEnv = process.env): boolean {
  return useClaudeStyleInput(env) && columns >= MIN_INPUT_BORDER_WIDTH;
}

export function inputContainerBorderColor(input: {
  permissionMode: PermissionMode;
  busy: boolean;
  pendingPermission: boolean;
}): string {
  if (input.pendingPermission) return C.error;
  if (input.busy) return C.running;
  if (input.permissionMode === "plan") return C.planMode;
  return C.inputBorder;
}
