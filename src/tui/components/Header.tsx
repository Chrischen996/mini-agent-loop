import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { TUI_COLORS as C } from "../theme.ts";
import { getGitBranch } from "../git-branch.ts";

type HeaderProps = {
  modelName?: string;
  cwd?: string;
};

/**
 * Single-row title bar. Keeps the fixed 3-row border-box height of the old
 * header while surfacing the active model and git branch inline (moved here
 * from StatusBar to avoid duplication).
 */
export function Header({ modelName, cwd }: HeaderProps): React.ReactElement {
  const [branch, setBranch] = useState<string>();

  useEffect(() => {
    if (!cwd) return;
    let active = true;
    const refreshBranch = () => {
      void getGitBranch(cwd).then((nextBranch) => {
        if (active) setBranch(nextBranch);
      });
    };

    refreshBranch();
    const interval = setInterval(refreshBranch, 5_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [cwd]);

  return (
    <Box borderStyle="single" borderColor={C.border} paddingX={1} gap={2}>
      <Text color={C.primary} bold>Hermes Agent</Text>
      {modelName && <Text color={C.info} wrap="truncate-end">{modelName}</Text>}
      {branch && <Text color={C.muted} wrap="truncate-end">⎇ {branch}</Text>}
    </Box>
  );
}
