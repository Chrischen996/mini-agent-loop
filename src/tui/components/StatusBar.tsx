import React from "react";
import { Box, Text } from "ink";

type StatusBarProps = {
  modelName: string;
  tokenEstimate: number;
  cwd: string;
  busy: boolean;
  width?: number;
};

export function StatusBar({ modelName, tokenEstimate, cwd, busy, width = 120 }: StatusBarProps): React.ReactElement {
  const cwdShort = cwd.length > 30 ? `…${cwd.slice(-28)}` : cwd;
  const compact = width < 112;

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
        {!compact && <Text dimColor>模型: </Text>}
        <Text color="cyan" wrap="truncate-end">{modelName}</Text>
        <Text dimColor>Tokens≈{tokenEstimate}</Text>
        {!compact && <Text dimColor wrap="truncate-end">{cwdShort}</Text>}
      </Box>
      <Box gap={2} flexShrink={1}>
        <Text dimColor wrap="truncate-end">[Tab] 切换  [/clear] 清空  [Ctrl+C] 退出</Text>
      </Box>
    </Box>
  );
}
