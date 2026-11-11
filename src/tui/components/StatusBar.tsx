import React from "react";
import { Box, Text } from "ink";
import type { PermissionMode } from "../state.ts";
import { TUI_COLORS as C } from "../theme.ts";
import { buildStatusSegments, type StatusLineInput } from "../status-line.ts";
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
  /** Compact goal status segment, for example `Goal 12K/50K`. */
  goalStatus?: string;
  permissionMode: PermissionMode;
  thinkingLevel: ModelThinkingLevel;
  cacheReadTokens?: number;
  promptTokens?: number;  // Total prompt tokens for accurate cache percentage
};

export function StatusBar({ modelName, tokenEstimate, contextWindow, busy, status = "Ready", queuedCount = 0, bgTaskCount, mcpStatus, goalStatus, permissionMode, thinkingLevel, cacheReadTokens, promptTokens }: StatusBarProps): React.ReactElement {
  const segments = buildStatusSegments({
    modelName,
    cwd: undefined,
    permissionMode,
    thinkingLevel,
    contextTokens: tokenEstimate,
    contextWindow,
    busy,
    status,
    queuedCount,
    mcpStatus,
    goalStatus,
    cacheReadTokens,
    promptTokens,
  } satisfies StatusLineInput);
  const bgTaskLabel = bgTaskCount !== undefined && bgTaskCount > 0
    ? ` · ${bgTaskCount} bg task${bgTaskCount === 1 ? "" : "s"}`
    : "";

  return (
    <Box
      borderStyle="round"
      borderColor={C.border}
      paddingX={1}
      flexDirection="column"
    >
      <Box>
        {segments.map((segment, segmentIndex) => (
          <Text
            key={`${segment.role}-${segmentIndex}`}
            color={segment.color}
            dimColor={segment.dim}
            bold={segment.bold}
            wrap="truncate-end"
          >{segment.text}</Text>
        ))}
        {bgTaskLabel && <Text color={C.running}>{bgTaskLabel}</Text>}
      </Box>
    </Box>
  );
}
