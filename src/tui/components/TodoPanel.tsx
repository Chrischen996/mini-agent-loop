import React from "react";
import { Box, Text } from "ink";
import { TUI_COLORS as C } from "../theme.ts";
import type { PlanDocument } from "../../plan/document.ts";
import type { TodoItem, TodoViewMode } from "../../todo.ts";
import { TODO_PANEL_MAX_VISIBLE_ITEMS } from "../todo-format.ts";
import { todoPanelRenderLines } from "../todo-lines.ts";

type TodoPanelProps = {
  plan?: PlanDocument;
  todos?: readonly TodoItem[];
  viewMode?: TodoViewMode;
  maxVisibleItems?: number;
};

export function TodoPanel({
  plan,
  todos,
  viewMode = "expanded",
  maxVisibleItems = TODO_PANEL_MAX_VISIBLE_ITEMS,
}: TodoPanelProps): React.ReactElement | null {
  const lines = todoPanelRenderLines({ plan, todos, viewMode, maxVisibleItems });
  if (!lines.length) return null;

  return (
    <Box flexDirection="column" paddingX={1} flexShrink={0}>
      {lines.map((line) => (
        <Text
          key={line.key}
          color={line.tone === "success" ? C.success : line.tone === "running" ? C.running : line.tone === "error" ? C.error : line.style === "todo" ? C.info : C.muted}
          bold={line.bold}
          dimColor={line.dim}
          strikethrough={line.strikethrough}
          wrap="truncate-end"
        >
          {line.prefix}{line.text}
        </Text>
      ))}
    </Box>
  );
}
