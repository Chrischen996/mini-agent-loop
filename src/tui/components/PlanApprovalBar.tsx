import React from "react";
import { Box, Text } from "ink";
import { TUI_COLORS as C } from "../theme.ts";
import type { ExecutionPlan } from "../../plan-act/types.ts";

type PlanApprovalBarProps = {
  plan: ExecutionPlan;
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
 * `useKeyboardHandler` and are unchanged. Occupies exactly 3 terminal rows.
 */
export function PlanApprovalBar({ plan }: PlanApprovalBarProps): React.ReactElement {
  const risks = countRisks(plan);
  return (
    <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor={C.primary}>
      <Box gap={1}>
        <Text color={C.primary} bold>📋 计划待审批</Text>
        <Text color={C.assistant}>{plan.summary}</Text>
      </Box>
      <Box gap={1}>
        <Text color={C.muted}>{risks.total} 步</Text>
        {risks.high > 0 && <Text color={C.error}>{risks.high} 高风险</Text>}
        {risks.medium > 0 && <Text color={C.running}>{risks.medium} 中风险</Text>}
        <Text color={C.muted}>·</Text>
        <Text color={C.selection} bold>A 批准</Text>
        <Text color={C.muted}>·</Text>
        <Text color={C.selection} bold>R 拒绝</Text>
      </Box>
    </Box>
  );
}
