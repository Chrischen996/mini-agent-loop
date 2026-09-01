import React from "react";
import { Box, Text } from "ink";
import { TUI_BRAND_HEADER_HEIGHT, TUI_BRAND_MARK, TUI_BRAND_NAME, TUI_BRAND_SPARK, TUI_BRAND_VERSION } from "../brand.ts";
import { TUI_COLORS as C } from "../theme.ts";
import { terminalStringWidth, truncateTerminalPath } from "../terminal-width.ts";
import { buildWelcomePanelRows, WELCOME_PANEL_MIN_WIDTH } from "../welcome-panel.ts";

type HeaderProps = {
  modelName?: string;
  billingLabel?: string;
  version?: string;
  cwd?: string;
  width?: number;
  showWelcome?: boolean;
};

/** Claude Code-style welcome frame, with a compact identity after chat starts. */
export function Header({ modelName, billingLabel, version, cwd, width = 80, showWelcome = false }: HeaderProps): React.ReactElement {
  if (showWelcome && width >= WELCOME_PANEL_MIN_WIDTH) {
    const rows = buildWelcomePanelRows(width, {
      title: TUI_BRAND_NAME,
      version: version ?? TUI_BRAND_VERSION,
      model: modelName,
      billing: billingLabel,
      cwd,
    });
    return (
      <Box flexDirection="column" width={width} height={rows.length} minWidth={0} overflow="hidden">
        {rows.map((row, index) => (
          <Text
            key={index}
            color={row.kind === "body" ? C.muted : row.kind === "border" ? C.primary : C.primary}
            bold={row.kind === "heading" || row.kind === "art"}
            dimColor={row.kind === "body"}
          >
            {row.text}
          </Text>
        ))}
      </Box>
    );
  }
  const markWidth = terminalStringWidth(`${TUI_BRAND_SPARK} ${TUI_BRAND_MARK} ${TUI_BRAND_SPARK}`);
  const pathBudget = Math.max(12, width - terminalStringWidth(modelName ?? "") - terminalStringWidth(TUI_BRAND_NAME) - markWidth - 9);
  const visibleCwd = cwd ? truncateTerminalPath(cwd, pathBudget) : undefined;
  return (
    <Box flexDirection="column" width={width} height={TUI_BRAND_HEADER_HEIGHT} minWidth={0} overflow="hidden">
      <Text color={C.primary} bold>{`  ${TUI_BRAND_SPARK}`}</Text>
      <Box paddingX={1} gap={1} width={width} height={1} minWidth={0} overflow="hidden">
        <Text color={C.primary} bold>{`${TUI_BRAND_SPARK} ${TUI_BRAND_MARK} ${TUI_BRAND_SPARK}`}</Text>
        <Text color={C.assistant} bold>{TUI_BRAND_NAME}</Text>
        {modelName && <Text color={C.info} dimColor wrap="truncate-end">{modelName}</Text>}
        {visibleCwd && <Text color={C.muted} dimColor wrap="truncate-end">· {visibleCwd}</Text>}
      </Box>
      <Text color={C.primary} bold>{`  ${TUI_BRAND_SPARK}`}</Text>
    </Box>
  );
}
