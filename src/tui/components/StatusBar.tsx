import React from "react";
import { Box, Text } from "ink";
import type { PermissionMode } from "../state.ts";
import { TUI_COLORS as C } from "../theme.ts";
import { formatContextWindow } from "./FileAutocomplete.tsx";
import { thinkingLevelToDisplay } from "../../think-intensity.ts";
import type { ModelThinkingLevel } from "../../pi-ai/types.ts";
import { permissionModeLabel, statusLabel, thinkingLevelLabel } from "../claude-style.ts";
import { terminalStringWidth, truncateTerminalPath } from "../terminal-width.ts";

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
  const modeColor = permissionMode === "plan" ? C.planMode : permissionMode === "bypass" ? C.error : C.info;
  const visibleStatus = statusLabel(status, busy);
  const cacheLabel = cacheReadTokens !== undefined && cacheReadTokens > 0
    ? promptTokens !== undefined && promptTokens > 0
      ? `Cache: ${Math.round(cacheReadTokens / promptTokens * 100)}% (${cacheReadTokens})`
      : `Cache: ${cacheReadTokens}`
    : undefined;
  const cwdWidth = Math.max(18, Math.floor(Math.max(40, width - 24) * 0.45));
  const visibleCwd = cwd && terminalStringWidth(cwd) > cwdWidth
    ? truncateTerminalPath(cwd, cwdWidth)
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
        <Text color={busy ? C.running : C.success}>{busy ? "⟳" : "·"}</Text>
        <Text color={busy ? C.running : C.success} bold wrap="truncate-end">{visibleStatus}</Text>
        {queuedCount > 0 && <Text color={C.running} dimColor wrap="truncate-end">{queuedCount} queued</Text>}
      </Box>
      <Box gap={1} flexWrap="nowrap" minWidth={0}>
        <Text color={C.info} wrap="truncate-end">{modelName}</Text>
        {visibleCwd && <Text color={C.muted} wrap="truncate-end">{visibleCwd}</Text>}
        <Text dimColor>·</Text>
        <Text color={C.thinking} wrap="truncate-end">{thinkingLevelLabel(thinkingLevelToDisplay(thinkingLevel))}</Text>
        <Text dimColor>·</Text>
        <Text dimColor wrap="truncate-end">{tokenEstimate} / {formatContextWindow(contextWindow)}</Text>
        <Text color={modeColor} dimColor wrap="truncate-end">{modeLabel}</Text>
        {cacheLabel && <Text color={C.info} dimColor wrap="truncate-end">{cacheLabel}</Text>}
      </Box>
    </Box>
  );
}
