import React from "react";
import { Box, Text } from "ink";
import type { PermissionMode } from "../state.ts";
import { TUI_COLORS as C } from "../theme.ts";
import { formatContextWindow } from "./FileAutocomplete.tsx";
import { thinkingLevelToDisplay } from "../../think-intensity.ts";
import type { ModelThinkingLevel } from "../../pi-ai/types.ts";

type StatusBarProps = {
  modelName: string;
  tokenEstimate: number;
  contextWindow: number;
  busy: boolean;
  status?: string;
  queuedCount?: number;
  /** Live background task counter, rendered as `N bg tasks` when non-zero. */
  bgTaskCount?: number;
  /** Compact MCP connection summary, for example `MCP 2 ready`. */
  mcpStatus?: string;
  permissionMode: PermissionMode;
  thinkingLevel: ModelThinkingLevel;
  cacheReadTokens?: number;
  promptTokens?: number;  // Total prompt tokens for accurate cache percentage
};

export function StatusBar({ modelName, tokenEstimate, contextWindow, busy, status = "Ready", queuedCount = 0, bgTaskCount, mcpStatus, permissionMode, thinkingLevel, cacheReadTokens, promptTokens }: StatusBarProps): React.ReactElement {
  const modeLabel = permissionMode === "plan" ? "Plan" : "Bypass";
  const isThinkingLevelStatus = /^(?:thinking level|思考强度)\s*[:：]/i.test(status.trim());

  return (
    <Box
      borderStyle="single"
      borderColor={C.border}
      paddingX={1}
      flexDirection="column"
    >
      <Box gap={2}>
        <Text color={busy ? C.running : C.success}>{busy ? "⟳ Working" : "● Ready"}</Text>
        {(busy || status !== "Ready") && !isThinkingLevelStatus && (
          <Text color={busy ? C.running : C.success} wrap="truncate-end">{status}</Text>
        )}
        {queuedCount > 0 && <Text color={C.running}>Queue: {queuedCount}</Text>}
        {bgTaskCount !== undefined && bgTaskCount > 0 && (
          <Text color={C.running}>{bgTaskCount} bg task{bgTaskCount === 1 ? "" : "s"}</Text>
        )}
        {mcpStatus && <Text color={C.muted} wrap="truncate-end">{mcpStatus}</Text>}
        <Text color={C.info} wrap="truncate-end">{modelName}</Text>
        <Text color={C.thinking} wrap="truncate-end">Thinking: {thinkingLevelToDisplay(thinkingLevel)}</Text>
        <Text dimColor>{tokenEstimate} / {formatContextWindow(contextWindow)}</Text>
        <Text color={C.thinking} wrap="truncate-end">{modeLabel}</Text>
        {cacheReadTokens !== undefined && cacheReadTokens > 0 && promptTokens !== undefined && promptTokens > 0 && (
          <Text color={C.info} wrap="truncate-end">
            CACHE:{Math.round(cacheReadTokens / promptTokens * 100)}% ({cacheReadTokens})
          </Text>
        )}
        {cacheReadTokens !== undefined && cacheReadTokens > 0 && promptTokens === undefined && (
          <Text color={C.info} wrap="truncate-end">
            CACHE:{cacheReadTokens}
          </Text>
        )}
      </Box>
      <Box gap={2}>
        <Text dimColor wrap="truncate-end">[PgUp/PgDn] scroll  [Ctrl+Y/Ctrl+Shift+C] copy  [Ctrl+V] paste image  [Ctrl+R] thinking  [Shift+Tab] mode  [/copy] transcript  [Ctrl+C] quit</Text>
      </Box>
    </Box>
  );
}
