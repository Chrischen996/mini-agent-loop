import React from "react";
import { Box, Text } from "ink";
import type { PlanDocument } from "../../plan/document.ts";
import type { TodoItem, TodoViewMode } from "../../todo.ts";
import { todoSummary } from "../../todo.ts";
import {
  resolveTodoItems,
  todoColor,
  todoIcon,
  todoText,
  TODO_PLAN_STATUS_LABELS,
  TODO_PANEL_MAX_VISIBLE_ITEMS,
} from "../todo-format.ts";

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
  if (viewMode === "hidden" || (!plan && !todos)) return null;
  const items = resolveTodoItems({ plan, todos });
  const summary = todoSummary(items);
  const visibleItems = viewMode === "compact" ? [] : items.slice(0, maxVisibleItems);
  const remaining = items.length - visibleItems.length;
  const planStatus = plan ? ` [${TODO_PLAN_STATUS_LABELS[plan.status]}]` : "";

  return (
    <Box flexDirection="column" paddingX={1} flexShrink={0}>
      <Box gap={1}>
        <Text color="cyan" bold>TODO</Text>
        <Text dimColor>{summary.completed}/{summary.total} 已完成</Text>
        {summary.inProgress > 0 && <Text color="yellow">{summary.inProgress} 执行中</Text>}
        {summary.failed > 0 && <Text color="red">{summary.failed} 失败</Text>}
        {planStatus && <Text color="cyan">{planStatus}</Text>}
      </Box>
      {viewMode === "compact" ? (
        <Text dimColor>
          {items.find((item) => item.status === "in_progress")?.activeForm ??
            (items.length > 0 ? "任务列表已折叠" : "暂无结构化任务")}
        </Text>
      ) : visibleItems.length === 0 ? (
        <Text dimColor>暂无结构化任务</Text>
      ) : (
        visibleItems.map((item) => (
          <Box key={item.id} gap={1}>
            <Text color={todoColor(item.status)}>{todoIcon(item.status)}</Text>
            <Text
              color={item.status === "completed" ? "green" : undefined}
              dimColor={item.status === "skipped"}
              strikethrough={item.status === "completed"}
              wrap="truncate-end"
            >
              {todoText(item.content)}
            </Text>
          </Box>
        ))
      )}
      {viewMode === "expanded" && remaining > 0 && <Text dimColor>... 还有 {remaining} 项</Text>}
    </Box>
  );
}
