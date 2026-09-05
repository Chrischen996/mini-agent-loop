import React from "react";
import { Box, Text } from "ink";
import type { TuiState } from "../state.ts";
import { TUI_COLORS as C } from "../theme.ts";
import { toolVisualName } from "../tool-lines.ts";

export function getWorkflowPanelRows(state: Pick<TuiState, "goal" | "steps" | "touchedFiles" | "toolCards">): number {
  const steps = state.steps.slice(-6);
  const files = state.touchedFiles.slice(-6);
  const tools = state.toolCards.slice(-4);
  if (!steps.length && !files.length && !tools.length) return 0;
  return 2 + (state.goal.trim() ? 1 : 0)
    + (steps.length ? 1 + steps.length : 0)
    + (files.length ? 1 + files.length : 0)
    + (tools.length ? 1 + tools.length : 0);
}

export function WorkflowPanel({ state }: { state: Pick<TuiState, "goal" | "steps" | "touchedFiles" | "toolCards"> }): React.ReactElement | null {
  const steps = state.steps.slice(-6);
  const files = state.touchedFiles.slice(-6);
  const tools = state.toolCards.slice(-4);
  if (!getWorkflowPanelRows(state)) return null;

  return (
    <Box flexDirection="column" paddingX={1} flexShrink={0} borderStyle="single" borderColor={C.border}>
      <Text color={C.running} bold>Workspace activity</Text>
      {state.goal.trim() && <Text color={C.muted} dimColor wrap="truncate-end">Task: {state.goal.trim().replace(/\s+/g, " ").slice(0, 100)}</Text>}
      {steps.length > 0 && <>
        <Text color={C.info} bold>Steps</Text>
        {steps.map((step) => <Text key={step.id} color={step.status === "error" ? C.error : step.status === "running" ? C.running : step.status === "done" ? C.success : C.muted} dimColor={step.status === "done"} wrap="truncate-end">
          {step.status === "done" ? "✓" : step.status === "error" ? "✗" : step.status === "running" ? "›" : "·"} {step.label}
        </Text>)}
      </>}
      {files.length > 0 && <>
        <Text color={C.info} bold>Files ({state.touchedFiles.length})</Text>
        {files.map((file) => <Text key={file} color={C.muted} dimColor wrap="truncate-end">· {file}</Text>)}
      </>}
      {tools.length > 0 && <>
        <Text color={C.info} bold>Recent tools</Text>
        {tools.map((tool) => <Text key={tool.id} color={tool.status === "error" ? C.error : tool.status === "running" ? C.running : C.success} wrap="truncate-end">
          {tool.status === "done" ? "✓" : tool.status === "error" ? "✗" : "⟳"} {toolVisualName(tool.name)}{tool.durationMs !== undefined ? ` · ${(tool.durationMs / 1000).toFixed(1)}s` : ""}
        </Text>)}
      </>}
    </Box>
  );
}
