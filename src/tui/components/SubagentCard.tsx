import React from "react";
import { Box, Text } from "ink";
import type { ChatMessage } from "../state.ts";
import type { RenderLine } from "../render-lines.ts";
import { subagentRenderLines } from "../subagent-lines.ts";
import { TUI_COLORS as C } from "../theme.ts";

type SubagentCallMessage = Extract<ChatMessage, { kind: "subagent_call" }>;

function lineColor(line: RenderLine): string {
  if (line.tone === "error") return C.error;
  if (line.tone === "running") return C.running;
  if (line.tone === "success") return C.success;
  if (line.style === "tool") return C.info;
  if (line.style === "thinking") return C.thinking;
  if (line.style === "user") return C.user;
  if (line.style === "error") return C.error;
  return C.assistant;
}

/**
 * SubagentCard renders a subagent invocation in the TUI message feed.
 *
 * Render the same Claude Code-style subagent rows used by the ANSI terminal.
 * This component intentionally has no border or independent layout model;
 * conversation semantics remain owned by the reducer and agent service.
 */
export function SubagentCard({ msg, width }: { msg: SubagentCallMessage; width?: number }): React.ReactElement {
  const rows = subagentRenderLines(msg, msg.id, { width });
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={0}>
      {rows.map((line) => (
        <Text
          key={line.key}
          color={lineColor(line)}
          dimColor={line.dim}
          bold={line.bold}
          italic={line.italic}
          strikethrough={line.strikethrough}
          wrap="wrap"
        >
          {`${" ".repeat(Math.max(0, line.indent ?? 0))}${line.prefix ?? ""}${line.text}`}
        </Text>
      ))}
    </Box>
  );
}
