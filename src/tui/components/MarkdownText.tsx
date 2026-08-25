import React from "react";
import { Box, Text } from "ink";
import { TUI_COLORS as C } from "../theme.ts";

/**
 * Lightweight terminal markdown renderer (pure Ink, no dependencies).
 *
 * Design constraint: renders exactly one visual row per source line (headers,
 * rules and list markers transform in place instead of inserting blank lines),
 * so `countTerminalRows(rawText)` in message-viewport.ts stays an accurate
 * height estimate — unlike the previous regex-based formatAssistantText which
 * injected newlines and caused viewport clipping drift.
 */

/** Parse inline `code` and **bold** spans into styled Text nodes. */
function renderInline(text: string, keyPrefix: string, baseColor?: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let seq = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(<Text key={`${keyPrefix}-p${seq}`} color={baseColor}>{text.slice(cursor, match.index)}</Text>);
      seq++;
    }
    if (match[1] !== undefined) {
      nodes.push(<Text key={`${keyPrefix}-b${seq}`} color={baseColor} bold>{match[1]}</Text>);
    } else if (match[2] !== undefined) {
      nodes.push(
        <Text key={`${keyPrefix}-c${seq}`} backgroundColor="#3a4149" color={C.info}>{match[2]}</Text>,
      );
    }
    cursor = match.index + match[0].length;
    seq++;
  }
  if (cursor < text.length) {
    nodes.push(<Text key={`${keyPrefix}-tail`} color={baseColor}>{text.slice(cursor)}</Text>);
  }
  return nodes;
}

const RULE_WIDTH = 48;

export function MarkdownText({ text }: { text: string }): React.ReactElement {
  const lines = text.split("\n");
  let inCodeBlock = false;

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        if (line.trimStart().startsWith("```")) {
          inCodeBlock = !inCodeBlock;
          return <Text key={i} color={C.muted}>{line}</Text>;
        }
        if (inCodeBlock) {
          return <Text key={i} color={C.info}>{line}</Text>;
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
          const level = heading[1]!.length;
          if (level <= 2) {
            return (
              <Text key={i} color={C.primary} bold>▸ {heading[2]}</Text>
            );
          }
          return (
            <Text key={i} color={C.selection} bold>· {heading[2]}</Text>
          );
        }

        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          return <Text key={i} color={C.border}>{"─".repeat(RULE_WIDTH)}</Text>;
        }

        const listItem = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
        if (listItem) {
          const indent = Math.floor(listItem[1]!.length / 2);
          const ordered = /\d/.test(listItem[2]!);
          return (
            <Box key={i} paddingLeft={indent * 2} gap={1}>
              <Text color={C.running}>{ordered ? listItem[2] : "•"}</Text>
              <Text color={C.assistant}>{renderInline(listItem[3]!, `li${i}`, C.assistant)}</Text>
            </Box>
          );
        }

        const quote = /^>\s?(.*)$/.exec(line);
        if (quote) {
          return <Text key={i} color={C.muted}>│ {quote[1]}</Text>;
        }

        return (
          <Text key={i} color={C.assistant}>{renderInline(line, `ln${i}`, C.assistant)}</Text>
        );
      })}
    </Box>
  );
}
