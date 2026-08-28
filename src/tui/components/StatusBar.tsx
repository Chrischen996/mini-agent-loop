import React from "react";
import { Box, Text } from "ink";
import type { PermissionMode } from "../state.ts";
import { TUI_COLORS as C } from "../theme.ts";
import { formatContextWindow } from "./FileAutocomplete.tsx";
import { thinkingLevelToDisplay } from "../../think-intensity.ts";
import type { ModelThinkingLevel } from "../../pi-ai/types.ts";
import { permissionModeLabel, statusLabel, thinkingLevelLabel } from "../claude-style.ts";
import { terminalStringWidth } from "../terminal-width.ts";

type StatusBarProps = {
  modelName: string;
  cwd?: string;
  width?: number;
  tokenEstimate: number;
  contextWindow: number;
  busy: boolean;
  status?: string;
  queuedCount?: number;
  permissionMode: PermissionMode;
  thinkingLevel: ModelThinkingLevel;
  cacheReadTokens?: number;
  promptTokens?: number;  // Total prompt tokens for accurate cache percentage
};

export function StatusBar({ modelName, cwd, width = 80, tokenEstimate, contextWindow, busy, status = "Ready", queuedCount = 0, permissionMode, thinkingLevel, cacheReadTokens, promptTokens }: StatusBarProps): React.ReactElement {
  const modeLabel = permissionModeLabel(permissionMode);
  const visibleStatus = statusLabel(status, busy);
  const cacheLabel = cacheReadTokens !== undefined && cacheReadTokens > 0
    ? promptTokens !== undefined && promptTokens > 0
      ? `Cache: ${Math.round(cacheReadTokens / promptTokens * 100)}% (${cacheReadTokens})`
      : `Cache: ${cacheReadTokens}`
    : undefined;
  const cwdWidth = Math.max(18, Math.floor(Math.max(40, width - 24) * 0.45));
  const visibleCwd = cwd && terminalStringWidth(cwd) > cwdWidth
    ? `…${cwd.slice(-Math.max(1, cwdWidth - 1))}`
    : cwd;

  return (
    <Box
      borderStyle="single"
      borderColor={C.border}
      paddingX={1}
      flexDirection="column"
      overflow="hidden"
    >
      <Box gap={1} flexWrap="nowrap" minWidth={0}>
        <Text color={busy ? C.running : C.success}>{busy ? "⟳" : "●"}</Text>
        <Text color={busy ? C.running : C.success} bold wrap="truncate-end">{visibleStatus}</Text>
        <Text dimColor>·</Text>
        <Text color={C.info} wrap="truncate-end">{modelName}</Text>
        {visibleCwd && <Text color={C.muted} wrap="truncate-end">{visibleCwd}</Text>}
        {queuedCount > 0 && <Text color={C.running} wrap="truncate-end">Queued: {queuedCount}</Text>}
      </Box>
      <Box gap={1} flexWrap="nowrap" minWidth={0}>
        <Text color={C.thinking} wrap="truncate-end">Thinking: {thinkingLevelLabel(thinkingLevelToDisplay(thinkingLevel))}</Text>
        <Text dimColor>·</Text>
        <Text dimColor wrap="truncate-end">{tokenEstimate} / {formatContextWindow(contextWindow)}</Text>
        <Text color={C.thinking} wrap="truncate-end">{modeLabel}</Text>
        {cacheLabel && <Text color={C.info} wrap="truncate-end">{cacheLabel}</Text>}
        <Text dimColor wrap="truncate-end">PgUp/PgDn scroll · Ctrl+Y copy · Ctrl+V attach image · Ctrl+R thinking · Shift+Tab permissions · /copy transcript · Ctrl+C exit</Text>
      </Box>
    </Box>
  );
}
