import React, { useState } from "react";
import { Box, Text } from "ink";
import type { ExecutionPlan, ExecutionStep, StepStatus } from "../../plan-act/types.ts";

type PlanViewProps = {
  plan: ExecutionPlan;
  onApprove: () => void;
  onReject: () => void;
  width?: number;
};

const STATUS_LABELS: Record<ExecutionPlan["status"], string> = {
  draft: "草稿",
  pending_review: "待审批",
  approved: "已批准",
  rejected: "已拒绝",
  modified: "已修改",
  executing: "执行中",
  completed: "已完成",
  failed: "失败",
};

const STATUS_COLORS: Record<ExecutionPlan["status"], Parameters<typeof Text>[0]["color"]> = {
  draft: "gray",
  pending_review: "cyan",
  approved: "green",
  rejected: "red",
  modified: "yellow",
  executing: "yellow",
  completed: "green",
  failed: "red",
};

const STEP_STATUS_ICON: Record<StepStatus, string> = {
  pending: "○",
  running: "▶",
  completed: "✓",
  failed: "✗",
  skipped: "–",
};

const STEP_STATUS_COLOR: Record<StepStatus, Parameters<typeof Text>[0]["color"]> = {
  pending: "gray",
  running: "yellow",
  completed: "green",
  failed: "red",
  skipped: "dim",
};

export function PlanView({ plan, onApprove, onReject, width = 32 }: PlanViewProps): React.ReactElement {
  const [expandedStep, setExpandedStep] = useState<number | null>(null);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1} width={width}>
      <Box gap={1}>
        <Text color="yellow">📋</Text>
        <Text bold>执行计划</Text>
        <Text color={STATUS_COLORS[plan.status]}>
          [{STATUS_LABELS[plan.status]}]
        </Text>
      </Box>

      {plan.summary && (
        <Box marginTop={1}>
          <Text dimColor>摘要:</Text>
          <Text wrap="truncate-end">{plan.summary}</Text>
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>── 步骤 ──</Text>
        {plan.steps.map((step, index) => (
          <Box key={step.id} flexDirection="column">
            <Box gap={1}>
              <Text color={(STEP_STATUS_COLOR[step.status as StepStatus] ?? "gray") as any}>
                {STEP_STATUS_ICON[step.status as StepStatus] ?? "○"}
              </Text>
              <Text bold>{index + 1}.</Text>
              <Text wrap="truncate-end">{step.description}</Text>
              {step.risk && step.risk !== "safe" && (
                <Text color={step.risk === "high" ? "red" : "yellow"}>
                  ⚠{step.risk}
                </Text>
              )}
            </Box>
            {expandedStep === index && step.rationale && (
              <Box paddingLeft={4}>
                <Text dimColor>原因: {step.rationale}</Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>

      {plan.risks.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>── 风险 ──</Text>
          {plan.risks.map((risk, i) => (
            <Box key={i} gap={1}>
              <Text color={risk.level === "high" || risk.level === "critical" ? "red" : "yellow"}>
                ⚠
              </Text>
              <Text wrap="truncate-end" color="cyan">
                {risk.description}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {plan.status === "pending_review" && (
        <Box marginTop={1} gap={1}>
          <Text color="green">[A]</Text>
          <Text>批准</Text>
          <Text dimColor>|</Text>
          <Text color="red">[R]</Text>
          <Text>拒绝</Text>
        </Box>
      )}
    </Box>
  );
}
