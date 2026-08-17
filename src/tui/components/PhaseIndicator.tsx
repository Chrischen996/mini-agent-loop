import React from "react";
import { Box, Text } from "ink";
import type { SessionPhase } from "../state.ts";

type PhaseIndicatorProps = {
  phase: SessionPhase;
  permissionMode: string;
};

const PHASE_LABELS: Record<SessionPhase, string> = {
  planning: "规划中",
  review: "待审批",
  acting: "执行中",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失败",
};

const PHASE_ICONS: Record<SessionPhase, string> = {
  planning: "📋",
  review: "⏳",
  acting: "▶️",
  completed: "✅",
  cancelled: "❌",
  failed: "⚠️",
};

const PHASE_COLORS: Record<SessionPhase, Parameters<typeof Text>[0]["color"]> = {
  planning: "yellow",
  review: "cyan",
  acting: "green",
  completed: "green",
  cancelled: "red",
  failed: "red",
};

export function PhaseIndicator({ phase, permissionMode }: PhaseIndicatorProps): React.ReactElement {
  return (
    <Box gap={1}>
      <Text color={PHASE_COLORS[phase]}>
        {PHASE_ICONS[phase]} {PHASE_LABELS[phase]}
      </Text>
      <Text dimColor>|</Text>
      <Text color="cyan">模式: {permissionMode}</Text>
    </Box>
  );
}
