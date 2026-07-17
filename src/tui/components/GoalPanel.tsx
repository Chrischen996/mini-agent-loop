import React from "react";
import { Box, Text } from "ink";
import type { WorkflowStep } from "../state.ts";

type GoalPanelProps = {
  goal: string;
  steps: WorkflowStep[];
  streamingText: string;
  lastResponse: string;
};

function progressBar(steps: WorkflowStep[], width = 20): string {
  const done = steps.filter((s) => s.status === "done").length;
  const total = steps.length || 1;
  const filled = Math.round((done / total) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function GoalPanel({ goal, steps, streamingText, lastResponse }: GoalPanelProps): React.ReactElement {
  const pct = steps.length
    ? Math.round((steps.filter((s) => s.status === "done").length / steps.length) * 100)
    : 0;

  const displayText = streamingText || lastResponse;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Box gap={1}>
        <Text color="yellow">🎯</Text>
        <Text bold color="white">
          目标
        </Text>
      </Box>
      <Text wrap="wrap" color="white">
        {goal || "等待输入..."}
      </Text>
      {steps.length > 0 && (
        <Box gap={2} marginTop={1}>
          <Text color="cyan">{progressBar(steps)}</Text>
          <Text dimColor>{pct}%</Text>
        </Box>
      )}
      {displayText ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>── 模型回复 ──────────────────</Text>
          <Text wrap="wrap" color="greenBright">
            {displayText.slice(-400)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
