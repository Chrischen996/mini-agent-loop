import React from "react";
import { Box, Text } from "ink";
import { TUI_COLORS as C } from "../theme.ts";

export function Header(): React.ReactElement {
  return (
    <Box borderStyle="single" borderColor={C.border} paddingX={1}>
      <Text color={C.primary} bold>
        Hermes Agent
      </Text>
    </Box>
  );
}
