import React from "react";
import { Box, Text } from "ink";
import type { PermissionMode } from "../state.ts";

type StatusBarProps = {
  modelName: string;
  tokenEstimate: number;
  cwd: string;
  busy: boolean;
  queuedCount?: number;
  permissionMode: PermissionMode;
  width?: number;
};

export function StatusBar({ modelName, tokenEstimate, cwd, busy, queuedCount = 0, permissionMode, width = 120 }: StatusBarProps): React.ReactElement {
  const cwdShort = cwd.length > 30 ? `…${cwd.slice(-28)}` : cwd;
  const compact = width < 112;
  const modeLabel = permissionMode === "plan" ? "计划" : permissionMode === "auto" ? "自动" : "绕过";

  return (
    <Box
      borderStyle="single"
      borderColor="cyan"
      paddingX={1}
      justifyContent="space-between"
      flexWrap="wrap"
    >
      <Box gap={2} flexShrink={1}>
        <Text color={busy ? "yellow" : "green"}>{busy ? "⟳ 运行中" : "● 就绪"}</Text>
        {queuedCount > 0 && <Text color="yellow">队列: {queuedCount}</Text>}
        {!compact && <Text dimColor>模型: </Text>}
        <Text color="cyan" wrap="truncate-end">{modelName}</Text>
        <Text dimColor>Tokens≈{tokenEstimate}</Text>
        <Text dimColor>权限: </Text>
        <Text color="magenta" wrap="truncate-end">{modeLabel}</Text>
        {!compact && <Text dimColor wrap="truncate-end">{cwdShort}</Text>}
      </Box>
      <Box gap={2} flexShrink={1}>
        <Text dimColor wrap="truncate-end">[Shift+Tab] 切换权限  [/clear] 清空  [Ctrl+C] 退出</Text>
      </Box>
    </Box>
  );
}
