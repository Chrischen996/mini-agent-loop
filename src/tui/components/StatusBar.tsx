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
  mcpStatus?: string;
  /** Live background task counter, rendered as `N bg tasks` when non-zero. */
  bgTaskCount?: number;
  permissionMode: PermissionMode;
  thinkingLevel: ModelThinkingLevel;
  cacheReadTokens?: number;
  promptTokens?: number;  // Total prompt tokens for accurate cache percentage
};

/**
 * Stable metadata chrome.
 *
 * Segment order, separators, truncation, and colors come from the
 * `status-line` module. This component maps those segments onto Ink text nodes.
 */
export const StatusBar = React.memo(function StatusBar({ modelName, cwd, width = 80, tokenEstimate, contextWindow, busy, status = "Ready", queuedCount = 0, mcpStatus, bgTaskCount, permissionMode, thinkingLevel, cacheReadTokens, promptTokens }: StatusBarProps): React.ReactElement {
  const bgTaskLabel = bgTaskCount && bgTaskCount > 0
    ? `${bgTaskCount} bg task${bgTaskCount === 1 ? "" : "s"}`
    : undefined;

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
    mcpStatus,
    cacheReadTokens,
    promptTokens,
    width,
  });

  if (bgTaskLabel) {
    segments.push({ role: "status", text: bgTaskLabel, color: "#555555", dim: true });
  }

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
});
