import React from "react";
import { Box, Text } from "ink";
import { TUI_COLORS as C } from "../theme.ts";
import type { UpdateInfo } from "../../update-check.ts";
import { UPGRADE_COMMAND } from "../../update-check.ts";

export type UpdateNoticeProps = {
  update: UpdateInfo;
  upgrading: boolean;
  result: string | null;
  width?: number;
};

/**
 * Transient upgrade offer shown above the prompt. Renders three states:
 * idle (offer the upgrade), running (npm in flight), and done (result line).
 * The parent owns key handling (u upgrade · Esc/n dismiss) and row budgeting.
 */
export function UpdateNotice({ update, upgrading, result, width = 80 }: UpdateNoticeProps): React.ReactElement {
  if (result !== null) {
    const failed = /failed|timed out|error/i.test(result);
    return (
      <Box paddingX={1} flexShrink={0} width={width} minWidth={0} flexDirection="column">
        <Text color={failed ? C.error : C.success} wrap="truncate-end">{result}</Text>
        <Text color={C.muted} dimColor wrap="truncate-end">Press Esc to dismiss · restart mini-agent-loop to use the new version</Text>
      </Box>
    );
  }

  if (upgrading) {
    return (
      <Box paddingX={1} flexShrink={0} width={width} minWidth={0} flexDirection="column">
        <Text color={C.running} wrap="truncate-end">⟳ Upgrading to {update.latest}… this may take a moment</Text>
        <Text color={C.muted} dimColor wrap="truncate-end">{UPGRADE_COMMAND}</Text>
      </Box>
    );
  }

  return (
    <Box paddingX={1} flexShrink={0} width={width} minWidth={0} flexDirection="column">
      <Text color={C.info} bold wrap="truncate-end">✦ New version {update.latest} available (you have {update.current})</Text>
      <Text color={C.muted} dimColor wrap="truncate-end">Press u to upgrade now · Esc to dismiss</Text>
    </Box>
  );
}
