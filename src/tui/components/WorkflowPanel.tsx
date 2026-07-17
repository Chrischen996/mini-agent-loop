import React from "react";
import { Box, Text } from "ink";
import type { WorkflowStep } from "../state.ts";

type WorkflowPanelProps = {
  steps: WorkflowStep[];
  touchedFiles: string[];
};

function stepIcon(status: WorkflowStep["status"]): { icon: string; color: string } {
  switch (status) {
    case "done":
      return { icon: "✓", color: "green" };
    case "running":
      return { icon: "▶", color: "yellow" };
    case "error":
      return { icon: "✗", color: "red" };
    default:
      return { icon: "□", color: "gray" };
  }
}

export function WorkflowPanel({ steps, touchedFiles }: WorkflowPanelProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1} width={28}>
      <Box gap={1}>
        <Text color="yellow">📋</Text>
        <Text bold>工作流</Text>
      </Box>
      <Box flexDirection="column" marginTop={1} gap={0}>
        {steps.length === 0 ? (
          <Text dimColor>暂无任务</Text>
        ) : (
          steps.map((step) => {
            const { icon, color } = stepIcon(step.status);
            return (
              <Box key={step.id} gap={1}>
                <Text color={color as Parameters<typeof Text>[0]["color"]}>{icon}</Text>
                <Text
                  color={step.status === "running" ? "white" : step.status === "done" ? "green" : "gray"}
                >
                  {step.label}
                </Text>
              </Box>
            );
          })
        )}
      </Box>
      {touchedFiles.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>── 涉及文件 ──</Text>
          {touchedFiles.slice(-6).map((f) => (
            <Box key={f} gap={1}>
              <Text color="cyan">●</Text>
              <Text dimColor>{f.length > 20 ? `…${f.slice(-18)}` : f}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
