import React from "react";
import { Box, Text } from "ink";
import { TUI_COLORS as C } from "../theme.ts";
import type { PendingTodoRunPlan } from "../state.ts";

type TodoRunPanelProps = {
  plan: PendingTodoRunPlan;
  width?: number;
  onConfirm?: () => void;
  onCancel?: () => void;
};

/**
 * Visual confirmation panel for a pending todo run plan.
 * Shows the dispatch plan and awaits user confirmation (A) or cancellation (Esc).
 */
export function TodoRunPanel({ plan, width = 80, onConfirm, onCancel }: TodoRunPanelProps): React.ReactElement {
  const running = plan.plan.tasks.some((t) => t.status === "running" || t.status === "completed" || t.status === "failed");

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.info} paddingX={1} width={width} minWidth={0} overflow="hidden">
      <Text bold color={C.info}>▣ Todo Run — {plan.plan.tasks.length} tasks</Text>
      {plan.plan.batches.map((batch, i) => (
        <Box key={i} gap={1}>
          <Text color={C.muted} dimColor>Batch {i}:</Text>
          {batch.map((id) => {
            const task = plan.plan.tasks.find((t) => t.todoId === id);
            if (!task) return null;
            const lock = plan.plan.resourceLocks[task.resourceClass] ? " [locked]" : "";
            return (
              <Text key={id} color={C.assistant} wrap="truncate-end">
                {task.label.slice(0, 20).padEnd(20)}{task.content.slice(0, 30).padEnd(30)}{task.runner}{lock}
              </Text>
            );
          })}
        </Box>
      ))}
      <Box gap={1}>
        <Text color={running ? C.running : C.success} bold>{running ? "⟳ Running…" : "✓ Done"}</Text>
      </Box>
      <Box gap={1}>
        <Text color={C.running} bold>❯ A  Execute</Text>
        <Text color={C.muted}>·</Text>
        <Text color={C.assistant}>Esc  Cancel</Text>
      </Box>
    </Box>
  );
}
