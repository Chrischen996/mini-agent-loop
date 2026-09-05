import React from "react";
import { Box, Text } from "ink";
import type { PermissionMode } from "../state.ts";
import type { ModelThinkingLevel } from "../../pi-ai/types.ts";
import { buildStatusSegments } from "../status-line.ts";

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

/**
 * Stable metadata chrome.
 *
 * Segment order, separators, truncation, and colors come from the shared
 * `status-line` module, which the standalone ANSI renderer also consumes. This
 * component only maps segments onto Ink text nodes, so the two clients can no
 * longer disagree about what the status row says.
 */
export function StatusBar({ modelName, cwd, width = 80, tokenEstimate, contextWindow, busy, status = "Ready", queuedCount = 0, permissionMode, thinkingLevel, cacheReadTokens, promptTokens }: StatusBarProps): React.ReactElement {
  const segments = buildStatusSegments({
    modelName,
    cwd,
    permissionMode,
    thinkingLevel,
    contextTokens: tokenEstimate,
    contextWindow,
    busy,
    status,
    queuedCount,
    cacheReadTokens,
    promptTokens,
    width,
  });

  return (
    <Box paddingX={1} flexWrap="nowrap" minWidth={0} overflow="hidden">
      {segments.map((segment, index) => (
        <Text
          key={`${segment.role}-${index}`}
          color={segment.color}
          dimColor={segment.dim}
          bold={segment.bold}
          wrap="truncate-end"
        >
          {segment.text}
        </Text>
      ))}
    </Box>
  );
}
