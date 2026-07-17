import React from "react";
import { Box, Text } from "ink";
import type { ToolCardState } from "../state.ts";
import { ToolCard } from "./ToolCard.tsx";

type TaskPanelProps = {
  toolCards: ToolCardState[];
  status: string;
};

export function TaskPanel({ toolCards, status }: TaskPanelProps): React.ReactElement {
  // Show at most 4 most-recent tool cards
  const visibleCards = toolCards.slice(-4);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1} flexGrow={1}>
      <Box gap={1}>
        <Text color="yellow">🔧</Text>
        <Text bold>工具活动</Text>
        <Text dimColor>({toolCards.length} 次调用)</Text>
      </Box>
      <Box flexDirection="column" marginTop={1} gap={0}>
        {visibleCards.length === 0 ? (
          <Text dimColor>等待工具调用...</Text>
        ) : (
          visibleCards.map((card) => <ToolCard key={card.id} card={card} />)
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>状态: </Text>
        <Text color="cyan">{status}</Text>
      </Box>
    </Box>
  );
}
