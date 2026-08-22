import React from "react";
import { Box, Text } from "ink";
import type { TodoItem } from "../../tools/todo.ts";
import { TUI_COLORS as C } from "../theme.ts";

export const MAX_VISIBLE_TODOS = 6;

function statusIcon(status: TodoItem["status"]): string {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "▶";
  return "○";
}

function displayContent(todo: TodoItem): string {
  return todo.status === "in_progress" && todo.activeForm
    ? todo.activeForm
    : todo.content;
}

export function formatTodoPanel(todos: TodoItem[]): string[] {
  if (todos.length === 0) return [];

  const completed = todos.filter((todo) => todo.status === "completed").length;
  const visible = todos.slice(0, MAX_VISIBLE_TODOS);
  const lines = [
    `TODO ${completed}/${todos.length}`,
    ...visible.map((todo) => `  ${statusIcon(todo.status)} ${displayContent(todo)}`),
  ];
  const remaining = todos.length - visible.length;
  if (remaining > 0) lines.push(`  … ${remaining} more`);
  return lines;
}

export function getTodoPanelRows(todos: TodoItem[]): number {
  return formatTodoPanel(todos).length;
}

function statusColor(status: TodoItem["status"]): string {
  if (status === "completed") return C.success;
  if (status === "in_progress") return C.running;
  return C.muted;
}

export function TodoPanel({ todos, width }: { todos: TodoItem[]; width: number }): React.ReactElement | null {
  const lines = formatTodoPanel(todos);
  if (lines.length === 0) return null;

  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      <Text color={C.primary} bold>{lines[0]}</Text>
      {todos.slice(0, MAX_VISIBLE_TODOS).map((todo) => (
        <Text key={todo.id} color={statusColor(todo.status)} wrap="truncate-end">
          {`  ${statusIcon(todo.status)} ${displayContent(todo)}`}
        </Text>
      ))}
      {todos.length > MAX_VISIBLE_TODOS && (
        <Text color={C.muted} wrap="truncate-end">
          {`  … ${todos.length - MAX_VISIBLE_TODOS} more`}
        </Text>
      )}
    </Box>
  );
}
