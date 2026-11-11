import React from "react";
import { Box, Text } from "ink";
import type { TodoItem, TodoViewMode } from "../../todo.ts";
import { taskSummaryRenderLines, type TaskSummaryStatus } from "../task-summary.ts";
import { renderLineColor } from "../render-line-format.ts";

export function TaskSummaryPanel({
  title,
  status,
  durationMs,
  totalTokens,
  todos,
  viewMode,
  width,
}: {
  title: string;
  status: TaskSummaryStatus;
  durationMs?: number;
  totalTokens?: number;
  todos: readonly TodoItem[];
  viewMode?: TodoViewMode;
  width?: number;
}): React.ReactElement | null {
  const lines = taskSummaryRenderLines({ title, status, durationMs, totalTokens, todos, viewMode, width });
  if (lines.length === 0) return null;
  return (
    <Box flexDirection="column" paddingX={1} flexShrink={0} width={width} minWidth={0} overflow="hidden">
      {lines.map((line) => (
        <Text
          key={line.key}
          color={renderLineColor(line.prefixTone === "error" ? { style: line.style, tone: "error" } : line)}
          dimColor={line.dim}
          bold={line.bold}
          strikethrough={line.strikethrough}
          wrap="truncate-end"
        >
          {line.prefix}{line.text}
        </Text>
      ))}
    </Box>
  );
}
