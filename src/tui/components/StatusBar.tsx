import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { PermissionMode } from "../state.ts";
import { TUI_COLORS as C } from "../theme.ts";
import { getGitBranch } from "../git-branch.ts";
import { formatContextWindow } from "./FileAutocomplete.tsx";
import { thinkingLevelToDisplay } from "../../think-intensity.ts";
import type { ModelThinkingLevel } from "../../pi-ai/types.ts";

type StatusBarProps = {
  modelName: string;
  tokenEstimate: number;
  contextWindow: number;
  cwd: string;
  busy: boolean;
  status?: string;
  queuedCount?: number;
  permissionMode: PermissionMode;
  thinkingLevel: ModelThinkingLevel;
  cacheReadTokens?: number;
  promptTokens?: number;  // Total prompt tokens for accurate cache percentage
};

export function StatusBar({ modelName, tokenEstimate, contextWindow, cwd, busy, status = "就绪", queuedCount = 0, permissionMode, thinkingLevel, cacheReadTokens, promptTokens }: StatusBarProps): React.ReactElement {
  const cwdShort = cwd.length > 30 ? `…${cwd.slice(-28)}` : cwd;
  const [branch, setBranch] = useState<string>();
  const modeLabel = permissionMode === "plan" ? "计划" : "绕过";

  useEffect(() => {
    let active = true;
    const refreshBranch = () => {
      void getGitBranch(cwd).then((nextBranch) => {
        if (active) setBranch(nextBranch);
      });
    };

    refreshBranch();
    const interval = setInterval(refreshBranch, 5_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [cwd]);

  return (
    <Box
      borderStyle="single"
      borderColor={C.border}
      paddingX={1}
      justifyContent="space-between"
      flexWrap="wrap"
    >
      <Box gap={2} flexShrink={1}>
        <Text color={busy ? C.running : C.success}>{busy ? "⟳ 运行中" : "● 就绪"}</Text>
        {(busy || status !== "就绪") && (
          <Text color={busy ? C.running : C.success} wrap="truncate-end">{status}</Text>
        )}
        {queuedCount > 0 && <Text color={C.running}>队列: {queuedCount}</Text>}
        <Text color={C.info} wrap="truncate-end">{modelName}</Text>
        <Text color={C.thinking} wrap="truncate-end">思考: {thinkingLevelToDisplay(thinkingLevel)}</Text>
        <Text dimColor>{tokenEstimate} / {formatContextWindow(contextWindow)}</Text>
        <Text color={C.thinking} wrap="truncate-end">{modeLabel}</Text>
        {branch && <Text color={C.info} wrap="truncate-end">⎇ {branch}</Text>}
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
      <Box gap={2} flexShrink={1}>
        <Text dimColor wrap="truncate-end">[PgUp/PgDn] 滚动  [Ctrl+Y] 复制  [Ctrl+R] 思考  [Shift+Tab] 模式  [/copy] 原文  [Ctrl+C] 退出</Text>
      </Box>
    </Box>
  );
}
