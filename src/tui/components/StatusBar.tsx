import React from "react";
import { Box, Text } from "ink";

type StatusBarProps = {
  modelName: string;
  tokenEstimate: number;
  cwd: string;
  busy: boolean;
};

export function StatusBar({ modelName, tokenEstimate, cwd, busy }: StatusBarProps): React.ReactElement {
  const cwdShort = cwd.length > 30 ? `…${cwd.slice(-28)}` : cwd;

  return (
    <Box
      borderStyle="single"
      borderColor="cyan"
      paddingX={1}
      justifyContent="space-between"
    >
      <Box gap={2}>
        <Text color={busy ? "yellow" : "green"}>{busy ? "⟳ 运行中" : "● 就绪"}</Text>
        <Text dimColor>模型: </Text>
        <Text color="cyan">{modelName}</Text>
        <Text dimColor>Tokens≈{tokenEstimate}</Text>
        <Text dimColor>{cwdShort}</Text>
      </Box>
      <Box gap={2}>
        <Text dimColor>[Tab] 切换  [/clear] 清空  [Ctrl+C] 退出</Text>
      </Box>
    </Box>
  );
}
