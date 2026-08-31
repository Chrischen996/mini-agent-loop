import React from "react";
import { Box, Text } from "ink";
import { TUI_COLORS as C } from "../theme.ts";
import { terminalStringWidth, truncateTerminalPath } from "../terminal-width.ts";

type HeaderProps = {
  modelName?: string;
  cwd?: string;
  width?: number;
};

/** Compact welcome identity row used by the Ink fallback entrypoint. */
export function Header({ modelName, cwd, width = 80 }: HeaderProps): React.ReactElement {
  const pathBudget = Math.max(12, width - terminalStringWidth(modelName ?? "") - 18);
  const visibleCwd = cwd ? truncateTerminalPath(cwd, pathBudget) : undefined;
  return (
    <Box paddingX={1} gap={1} width={width} minWidth={0} overflow="hidden">
      <Text color={C.primary} bold>Claude Code</Text>
      {modelName && <Text color={C.info} dimColor wrap="truncate-end">{modelName}</Text>}
      {visibleCwd && <Text color={C.muted} dimColor wrap="truncate-end">· {visibleCwd}</Text>}
    </Box>
  );
}
