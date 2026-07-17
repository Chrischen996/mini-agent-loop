import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

type HeaderProps = {
  modelName: string;
  busy: boolean;
  turnCount: number;
};

export function Header({ modelName, busy, turnCount }: HeaderProps): React.ReactElement {
  return (
    <Box borderStyle="single" borderColor="cyan" paddingX={1} justifyContent="space-between">
      <Box gap={1}>
        <Text color="cyan" bold>
          Hermes Agent
        </Text>
        <Text dimColor>TUI</Text>
        {busy && (
          <Box gap={1}>
            <Text color="yellow">
              <Spinner type="dots" />
            </Text>
            <Text color="yellow">运行中</Text>
          </Box>
        )}
        {!busy && <Text color="green">● 就绪</Text>}
      </Box>
      <Box gap={2}>
        <Text dimColor>轮次: {turnCount}</Text>
        <Text color="cyan">{modelName}</Text>
      </Box>
    </Box>
  );
}
