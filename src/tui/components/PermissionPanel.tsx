import React from "react";
import { Box, Text } from "ink";
import { TUI_COLORS as C } from "../theme.ts";
import type { PendingPermissionState } from "../state.ts";

type PermissionPanelProps = {
  request: PendingPermissionState;
};

const RISK_LABELS: Record<PendingPermissionState["risk"], string> = {
  safe: "低风险",
  medium: "中风险",
  high: "高风险",
};

function riskColor(risk: PendingPermissionState["risk"]): string {
  if (risk === "high") return C.error;
  if (risk === "medium") return C.running;
  return C.success;
}

/**
 * Visual confirmation card shown while a tool permission request is pending.
 *
 * Pure presentation: the A/D/Enter/Esc key mapping lives in
 * `pending-permission.ts` + `useKeyboardHandler` and is unchanged. The panel
 * occupies exactly 4 terminal rows (2 border rows + 2 content rows) so the
 * feed height budget can reserve it deterministically.
 */
export function PermissionPanel({ request }: PermissionPanelProps): React.ReactElement {
  const accent = riskColor(request.risk);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
      <Box gap={1}>
        <Text color={accent} bold>⚠ 权限确认</Text>
        <Text color={C.assistant} bold>{request.tool}</Text>
        <Text backgroundColor={accent} color={C.badgeText}> {RISK_LABELS[request.risk]} </Text>
      </Box>
      <Box gap={1}>
        <Text color={C.selection} bold>▶</Text>
        <Text color={C.assistant}>A 允许</Text>
        <Text color={C.muted}>·</Text>
        <Text color={C.assistant}>D/Enter 拒绝</Text>
        <Text color={C.muted}>·</Text>
        <Text color={C.muted}>Esc 取消</Text>
      </Box>
    </Box>
  );
}
