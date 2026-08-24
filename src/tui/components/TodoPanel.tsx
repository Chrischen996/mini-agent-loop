import React from "react";
import { Box, Text } from "ink";
import type { TodoItem } from "../../tools/todo.ts";
import type { PlanDocument, PlanDocumentStep, PlanStepStatus } from "../../plan/document.ts";
import { TUI_COLORS as C } from "../theme.ts";

// ── TodoItem-based todo list panel (todo_write tool) ────────────────────────

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

export function getTodoItemRows(todos: TodoItem[]): number {
  return formatTodoPanel(todos).length;
}

function statusColor(status: TodoItem["status"]): string {
  if (status === "completed") return C.success;
  if (status === "in_progress") return C.running;
  return C.muted;
}

export function TodoItemsPanel({ todos, width }: { todos: TodoItem[]; width: number }): React.ReactElement | null {
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

// ── PlanDocument-based plan panel (plan document) ───────────────────────────

type PlanTodoPanelProps = {
  plan: PlanDocument;
  maxVisibleSteps?: number;
};

export const TODO_PANEL_MAX_VISIBLE_STEPS = 8;

const STATUS_LABELS: Record<PlanDocument["status"], string> = {
  pending: "待审批",
  approved: "已批准",
  rejected: "已拒绝",
  executing: "执行中",
  completed: "已完成",
  failed: "失败",
};

const STEP_ICONS: Record<PlanStepStatus, string> = {
  todo: "☐",
  doing: "…",
  done: "✓",
  skipped: "-",
  failed: "✗",
};

const STEP_COLORS: Record<PlanStepStatus, "gray" | "yellow" | "green" | "red"> = {
  todo: "gray",
  doing: "yellow",
  done: "green",
  skipped: "gray",
  failed: "red",
};

const STATUS_COLORS: Record<PlanDocument["status"], "gray" | "yellow" | "green" | "red" | "cyan"> = {
  pending: "cyan",
  approved: "green",
  rejected: "red",
  executing: "yellow",
  completed: "green",
  failed: "red",
};

function stepText(step: PlanDocumentStep): string {
  const text = step.text.replace(/\s+/g, " ").trim();
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

export function getTodoPanelRows(plan?: PlanDocument): number {
  if (!plan) return 0;
  const stepCount = plan.steps?.length ?? 0;
  const visibleSteps = Math.min(stepCount, TODO_PANEL_MAX_VISIBLE_STEPS);
  return 1 + Math.max(1, visibleSteps) + (stepCount > TODO_PANEL_MAX_VISIBLE_STEPS ? 1 : 0);
}

export function TodoPanel({ plan, maxVisibleSteps = TODO_PANEL_MAX_VISIBLE_STEPS }: PlanTodoPanelProps): React.ReactElement {
  const steps = plan.steps ?? [];
  const visibleSteps = steps.slice(0, maxVisibleSteps);
  const remaining = steps.length - visibleSteps.length;
  const done = steps.filter((step) => step.status === "done").length;

  return (
    <Box flexDirection="column" paddingX={1} flexShrink={0}>
      <Box gap={1}>
        <Text color="cyan" bold>TODO</Text>
        <Text color={STATUS_COLORS[plan.status]}>[{STATUS_LABELS[plan.status]}]</Text>
        <Text dimColor>{done}/{steps.length}</Text>
      </Box>
      {visibleSteps.length === 0 ? (
        <Text dimColor>暂无结构化步骤</Text>
      ) : (
        visibleSteps.map((step) => {
          const status = step.status ?? "todo";
          return (
            <Box key={`${plan.id}-${step.index}`} gap={1}>
              <Text color={STEP_COLORS[status]}>{STEP_ICONS[status]}</Text>
              <Text color={status === "done" ? "green" : undefined}>{step.index}.</Text>
              <Text wrap="truncate-end">{stepText(step)}</Text>
            </Box>
          );
        })
      )}
      {remaining > 0 && <Text dimColor>... 还有 {remaining} 项</Text>}
    </Box>
  );
}
