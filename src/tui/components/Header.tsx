import React from "react";
import { Box, Text } from "ink";
import { TUI_COLORS as C } from "../theme.ts";

type HeaderProps = {
  modelName?: string;
  cwd?: string;
};

/** Minimal Claude Code title row used only by the Ink fallback entrypoint. */
export function Header({ modelName, cwd }: HeaderProps): React.ReactElement {
  return (
    <Box paddingX={1}>
      <Text color={C.primary} bold>Claude Code</Text>
    </Box>
  );
}
