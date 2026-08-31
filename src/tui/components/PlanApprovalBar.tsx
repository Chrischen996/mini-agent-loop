import React from "react";
import { Box, Text } from "ink";
import { TUI_COLORS as C } from "../theme.ts";
import type { ExecutionPlan } from "../../plan-act/types.ts";
import { executionStepStatusToTodoStatus, todoIcon } from "../todo-format.ts";

type PlanApprovalBarProps = {
  plan: ExecutionPlan;
  width?: number;
};

function countRisks(plan: ExecutionPlan): { high: number; medium: number; total: number } {
  let high = 0;
  let medium = 0;
  for (const step of plan.steps) {
    if (step.risk === "high") high++;
    else if (step.risk === "medium") medium++;
  }
  return { high, medium, total: plan.steps.length };
}

/**
 * Compact approval bar shown while a generated execution plan awaits review.
 *
 * Step details are already rendered by TodoPanel (todoItems are derived from
 * the same ExecutionPlan), so this stays intentionally slim: summary + step
 * counts + key hints. Pure presentation — the A/R shortcuts live in
 * `useKeyboardHandler` and are unchanged. The layout reserves the full
 * bordered card footprint, including up to four step rows.
 */
export function PlanApprovalBar({ plan, width }: PlanApprovalBarProps): React.ReactElement {
  const risks = countRisks(plan);
  return (
    <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor={C.primary} width={width} minWidth={0} overflow="hidden">
      <Box gap={1} minWidth={0}>
        <Text color={C.primary} bold wrap="truncate-end">▣ Plan approval</Text>
      </Box>
      <Text color={C.assistant} wrap="truncate-end">{plan.summary}</Text>
      {plan.steps.slice(0, 4).map((step, index) => (
        <Text key={step.id} color={C.muted} dimColor={step.status === "completed" || step.status === "skipped"} strikethrough={step.status === "completed"} wrap="truncate-end">
          {todoIcon(executionStepStatusToTodoStatus(step.status))} {index + 1}. {step.description}
        </Text>
      ))}
      {plan.steps.length > 4 && <Text color={C.muted} dimColor>… {plan.steps.length - 4} more steps</Text>}
      <Box gap={1}>
        <Text color={C.muted}>{risks.total} steps</Text>
        {risks.high > 0 && <Text color={C.error}>{risks.high} high risk</Text>}
        {risks.medium > 0 && <Text color={C.running}>{risks.medium} medium risk</Text>}
        <Text color={C.muted}>·</Text>
        <Text color={C.running} bold>❯ Approve</Text>
        <Text color={C.muted}>·</Text>
        <Text color={C.assistant}>Reject</Text>
      </Box>
      <Text color={C.muted} dimColor>A approve  ·  R reject</Text>
    </Box>
  );
}
