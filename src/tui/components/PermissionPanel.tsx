import React from "react";
import { Box, Text } from "ink";
import { TUI_COLORS as C } from "../theme.ts";
import type { PendingPermissionState } from "../state.ts";
import { permissionRiskLabel, toolArgumentSummary } from "../claude-style.ts";
import { toolVisualName } from "../tool-lines.ts";

type PermissionPanelProps = {
  request: PendingPermissionState;
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
 * occupies six terminal rows (2 border rows + 4 content rows) so the feed
 * height budget can reserve it deterministically.
 */
export function PermissionPanel({ request }: PermissionPanelProps): React.ReactElement {
  const accent = riskColor(request.risk);
  const argument = toolArgumentSummary(request.tool, request.arguments ?? {});
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
      <Box gap={1}>
        <Text color={accent} bold>Permission required</Text>
        <Text color={C.assistant} bold>{toolVisualName(request.tool)}</Text>
        {argument && <Text color={C.info} wrap="truncate-end">({argument})</Text>}
      </Box>
      <Box gap={1}>
        <Text color={C.muted} dimColor>Risk: {permissionRiskLabel(request.risk)}</Text>
      </Box>
      <Box gap={1}>
        <Text color={C.assistant}>Do you want to proceed?</Text>
      </Box>
      <Box gap={1}>
        <Text color={C.selection} bold>❯ Allow</Text>
        <Text color={C.muted}>·</Text>
        <Text color={C.assistant}>Deny</Text>
        <Text color={C.muted}>·</Text>
        <Text color={C.muted}>Esc cancel</Text>
      </Box>
    </Box>
  );
}
