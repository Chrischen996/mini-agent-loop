import React from "react";
import { Box, Text } from "ink";
import type { PermissionMode } from "../state.ts";
import { TUI_COLORS as C } from "../theme.ts";

type StatusBarProps = {
  modelName: string;
  tokenEstimate: number;
  cwd: string;
  busy: boolean;
  status?: string;
  queuedCount?: number;
  permissionMode: PermissionMode;
  width?: number;
};

export function StatusBar({ modelName, tokenEstimate, cwd, busy, status = "就绪", queuedCount = 0, permissionMode, width = 120 }: StatusBarProps): React.ReactElement {
  const cwdShort = cwd.length > 30 ? `…${cwd.slice(-28)}` : cwd;
  const compact = width < 112;
  const modeLabel = permissionMode === "plan" ? "计划" : permissionMode === "manual" ? "手动" : permissionMode === "auto" ? "自动" : "绕过";

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
        {!compact && <Text dimColor>模型: </Text>}
        <Text color={C.info} wrap="truncate-end">{modelName}</Text>
        <Text dimColor>Tokens≈{tokenEstimate}</Text>
        <Text dimColor>权限: </Text>
        <Text color={C.thinking} wrap="truncate-end">{modeLabel}</Text>
        {!compact && <Text dimColor wrap="truncate-end">{cwdShort}</Text>}
      </Box>
      <Box gap={2} flexShrink={1}>
        <Text dimColor wrap="truncate-end">[Shift+Tab] 切换权限  [/clear] 清空  [Ctrl+C] 退出</Text>
      </Box>
    </Box>
  );
}
