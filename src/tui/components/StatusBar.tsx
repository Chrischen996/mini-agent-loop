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
  permissionMode: PermissionMode;
  thinkingLevel: ModelThinkingLevel;
  cacheReadTokens?: number;
  promptTokens?: number;  // Total prompt tokens for accurate cache percentage
};

export function StatusBar({ modelName, tokenEstimate, contextWindow, busy, status = "就绪", queuedCount = 0, permissionMode, thinkingLevel, cacheReadTokens, promptTokens }: StatusBarProps): React.ReactElement {
  const modeLabel = permissionMode === "plan" ? "计划" : permissionMode === "approval" ? "审批" : "绕过";

  return (
    <Box
      borderStyle="single"
      borderColor={C.border}
      paddingX={1}
      flexDirection="column"
    >
      <Box gap={2}>
        <Text color={busy ? C.running : C.success}>{busy ? "⟳ 运行中" : "● 就绪"}</Text>
        {(busy || status !== "就绪") && (
          <Text color={busy ? C.running : C.success} wrap="truncate-end">{status}</Text>
        )}
        {queuedCount > 0 && <Text color={C.running}>队列: {queuedCount}</Text>}
        <Text color={C.info} wrap="truncate-end">{modelName}</Text>
        <Text color={C.thinking} wrap="truncate-end">思考: {thinkingLevelToDisplay(thinkingLevel)}</Text>
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
        <Text dimColor wrap="truncate-end">[PgUp/PgDn] 滚动  [Ctrl+Y/Ctrl+Shift+C] 复制  [Ctrl+V] 粘贴图片  [Ctrl+R] 思考  [Shift+Tab] 模式  [/copy] 原文  [Ctrl+C] 退出</Text>
      </Box>
    </Box>
  );
}
