import React from "react";
import { Box, Text } from "ink";
import { TUI_BRAND_HEADER_HEIGHT, TUI_BRAND_NAME, TUI_BRAND_VERSION } from "../brand.ts";
import { TUI_COLORS as C } from "../theme.ts";
import { terminalStringWidth, truncateTerminalPath } from "../terminal-width.ts";
import { hexToAnsi } from "../render-line-format.ts";
import { buildWelcomePanelRows, WELCOME_PANEL_MIN_WIDTH } from "../welcome-panel.ts";

type HeaderProps = {
  modelName?: string;
  billingLabel?: string;
  version?: string;
  cwd?: string;
  width?: number;
  showWelcome?: boolean;
  dashboardOpen?: boolean;
};

/** Claude Code-style welcome frame, with a compact identity after chat starts. */
export const Header = React.memo(function Header({ modelName, billingLabel, version, cwd, width = 80, showWelcome = false, dashboardOpen = false }: HeaderProps): React.ReactElement {
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
  const dashboardLabel = width < 50 ? "Dashboard" : "Dashboard Ctrl+\\";
  const dashboardWidth = terminalStringWidth(dashboardLabel);
  const pathBudget = Math.max(4, width - terminalStringWidth(modelName ?? "") - terminalStringWidth(TUI_BRAND_NAME) - dashboardWidth - 10);
  const visibleCwd = cwd ? truncateTerminalPath(cwd, pathBudget) : undefined;
  return (
    <Box flexDirection="column" width={width} height={TUI_BRAND_HEADER_HEIGHT} minWidth={0} overflow="hidden">
      <Box paddingX={1} justifyContent="space-between" width={width} height={1} minWidth={0} overflow="hidden">
        <Box gap={1} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          <Text color={C.assistant} bold>{TUI_BRAND_NAME}</Text>
          {modelName && <Text color={C.info} dimColor wrap="truncate-end">{modelName}</Text>}
          {visibleCwd && <Text color={C.muted} dimColor wrap="truncate-end">· {visibleCwd}</Text>}
        </Box>
        <Text backgroundColor={dashboardOpen ? C.primary : C.selection} color={C.assistant} bold wrap="truncate-end">{` ${dashboardLabel} `}</Text>
      </Box>
    </Box>
  );
});

/**
 * Self-contained ANSI line for the document layout's one-time header burst:
 * the identity bar is printed into the terminal stream at session start and
 * scrolls away with the conversation instead of being pinned to the frame.
 * Styling mirrors the compact <Header> (bold brand, dim model, dim path).
 */
export function headerStaticText(options: { width: number; modelName?: string; cwd?: string }): string {
  const { width, modelName, cwd } = options;
  const dashboardWidth = terminalStringWidth("Dashboard Ctrl+\\");
  const pathBudget = Math.max(4, width - terminalStringWidth(modelName ?? "") - terminalStringWidth(TUI_BRAND_NAME) - dashboardWidth - 10);
  const visibleCwd = cwd ? truncateTerminalPath(cwd, pathBudget) : undefined;
  const segment = (codes: string, text: string) => `\x1b[${codes}m${text}\x1b[0m`;
  const parts = [segment(`1;${hexToAnsi(C.assistant)}`, ` ${TUI_BRAND_NAME}`)];
  if (modelName) parts.push(segment(`2;${hexToAnsi(C.info)}`, ` ${modelName}`));
  if (visibleCwd) parts.push(segment(`2;${hexToAnsi(C.muted)}`, ` · ${visibleCwd}`));
  return parts.join("");
}
