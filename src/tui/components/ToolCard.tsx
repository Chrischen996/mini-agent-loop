import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { ToolCardState } from "../state.ts";

type ToolCardProps = {
  card: ToolCardState;
};

export function ToolCard({ card }: ToolCardProps): React.ReactElement {
  const isRunning = card.status === "running";
  const isError = card.status === "error";

  const borderColor = isError ? "red" : isRunning ? "yellow" : "green";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      marginBottom={0}
    >
      <Box gap={1} justifyContent="space-between">
        <Box gap={1}>
          {isRunning ? (
            <Text color="yellow">
              <Spinner type="dots" />
            </Text>
          ) : (
            <Text color={isError ? "red" : "green"}>{isError ? "✗" : "✓"}</Text>
          )}
          <Text bold color={isRunning ? "yellow" : isError ? "red" : "green"}>
            {card.name}
          </Text>
        </Box>
        {card.durationMs !== undefined && (
          <Text dimColor>{card.durationMs}ms</Text>
        )}
      </Box>
      {card.args && (
        <Text dimColor wrap="truncate-end">
          {card.args}
        </Text>
      )}
      {card.preview && (
        <Text color="white" wrap="truncate-end">
          {card.preview}
        </Text>
      )}
    </Box>
  );
}
