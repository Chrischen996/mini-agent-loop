import React from "react";
import { Box, Text } from "ink";
import { TUI_COLORS as C } from "../theme.ts";
import { panelBorderStyle } from "../pixel-glyphs.ts";
import type { PendingModeRequestState } from "../state.ts";
import { modeRequestLabel } from "../mode-request.ts";

type ModeRequestPanelProps = {
  request: PendingModeRequestState;
  width?: number;
};

/**
 * Confirmation card for a model-initiated permission-mode switch.
 *
 * Deliberately parallel to `PermissionPanel`: the model asks, the human
 * answers, and the mode only changes on `A`. It occupies the same four
 * content rows so the feed-height budget stays unchanged.
 */
export const ModeRequestPanel = React.memo(function ModeRequestPanel({ request, width }: ModeRequestPanelProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle={panelBorderStyle()} borderColor={C.running} paddingX={1} width={width} minWidth={0} overflow="hidden">
      <Box gap={1} minWidth={0}>
        <Text color={C.running} bold wrap="truncate-end">⇄ Mode switch requested</Text>
      </Box>
      <Text color={C.assistant} wrap="truncate-end">{modeRequestLabel(request.mode)}</Text>
      <Text color={C.muted} dimColor wrap="truncate-end">{request.reason}</Text>
      <Box gap={1}>
        <Text color={C.running} bold>❯ A Switch</Text>
        <Text color={C.muted}>·</Text>
        <Text color={C.assistant}>D/Enter/Esc keep current</Text>
      </Box>
    </Box>
  );
});
