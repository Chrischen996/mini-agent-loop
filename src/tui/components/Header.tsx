import React from "react";
import { Box, Text } from "ink";

type HeaderProps = {
  modelName: string;
  turnCount: number;
};

export function Header({ modelName, turnCount }: HeaderProps): React.ReactElement {
  return (
    <Box borderStyle="single" borderColor="cyan" paddingX={1} justifyContent="space-between" gap={2}>
      <Box gap={1} flexGrow={1} flexShrink={1}>
        <Text color="cyan" bold>
          Hermes Agent
        </Text>
        <Text dimColor>TUI</Text>
      </Box>
      <Box gap={2} flexShrink={1}>
        <Text dimColor>轮次: {turnCount}</Text>
        <Text color="cyan" wrap="truncate-end">{modelName}</Text>
      </Box>
    </Box>
  );
}
