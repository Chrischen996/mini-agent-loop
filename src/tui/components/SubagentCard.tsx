import React from "react";
import { Box, Text } from "ink";
import type { ChatMessage } from "../state.ts";
import { subagentRenderLines } from "../subagent-lines.ts";
import { renderLineColor } from "../render-line-format.ts";

type SubagentCallMessage = Extract<ChatMessage, { kind: "subagent_call" }>;

/**
 * SubagentCard renders a subagent invocation in the TUI message feed.
 *
 * Render Claude Code-style subagent rows from the shared presentation model.
 * This component intentionally has no border or independent layout model;
 * conversation semantics remain owned by the reducer and agent service.
 */
export function SubagentCard({ msg, width }: { msg: SubagentCallMessage; width?: number }): React.ReactElement {
  const rows = subagentRenderLines(msg, msg.id, { width });
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={0} width={width} minWidth={0} overflow="hidden">
      {rows.map((line) => (
        <Text
          key={line.key}
          color={renderLineColor(line)}
          dimColor={line.dim}
          bold={line.bold}
          italic={line.italic}
          strikethrough={line.strikethrough}
          wrap="truncate-end"
        >
          {`${" ".repeat(Math.max(0, line.indent ?? 0))}${line.prefix ?? ""}${line.text}`}
        </Text>
      ))}
    </Box>
  );
}
