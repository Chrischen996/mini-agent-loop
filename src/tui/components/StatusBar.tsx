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

  const idleStatus = !busy && visibleStatus !== "Ready" ? visibleStatus : undefined;

  return (
    <Box paddingX={1} gap={1} flexWrap="nowrap" minWidth={0} overflow="hidden">
      <Text color={C.success}>·</Text>
      <Text color={C.info} wrap="truncate-end">{modelName}</Text>
      {visibleCwd && width >= 52 && <Text color={C.muted} wrap="truncate-end">{visibleCwd}</Text>}
      <Text dimColor>·</Text>
      {width >= 68 && (
        <>
          <Text color={C.thinking} wrap="truncate-end">{thinkingLevelLabel(thinkingLevelToDisplay(thinkingLevel))}</Text>
          <Text dimColor>·</Text>
        </>
      )}
      <Text dimColor wrap="truncate-end">Context {tokenEstimate} / {formatContextWindow(contextWindow)}</Text>
      <Text color={modeColor} dimColor wrap="truncate-end">{modeLabel}</Text>
      {idleStatus && <Text color={C.muted} dimColor wrap="truncate-end">{idleStatus}</Text>}
      {queuedCount > 0 && <Text color={C.running} dimColor wrap="truncate-end">{queuedCount} queued</Text>}
      {cacheLabel && width >= 100 && <Text color={C.info} dimColor wrap="truncate-end">{cacheLabel}</Text>}
    </Box>
  );
}
