import React from "react";
import { Box, Text } from "ink";
import { TUI_COLORS as C } from "../theme.ts";
import { parseMarkdownLines } from "../markdown-lines.ts";

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
  const lines = parseMarkdownLines(text);

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        if (line.kind === "code-fence") return <Text key={i} color={C.muted}>{line.text}</Text>;
        if (line.kind === "code") return <Text key={i} color={C.info}>{line.text}</Text>;
        if (line.kind === "heading") {
          const level = line.level;
          if (level <= 2) {
            return <Text key={i} color={C.primary} bold>▸ {line.text}</Text>;
          }
          return <Text key={i} color={C.selection} bold>· {line.text}</Text>;
        }
        if (line.kind === "rule") return <Text key={i} color={C.border}>{"─".repeat(RULE_WIDTH)}</Text>;
        if (line.kind === "list") {
          return (
            <Box key={i} paddingLeft={line.indent * 2} gap={1}>
              <Text color={C.running}>{line.ordered ? line.marker : "•"}</Text>
              <Text color={C.assistant}>{renderInline(line.text, `li${i}`, C.assistant)}</Text>
            </Box>
          );
        }
        if (line.kind === "quote") return <Text key={i} color={C.muted}>│ {line.text}</Text>;
        return <Text key={i} color={C.assistant}>{renderInline(line.text, `ln${i}`, C.assistant)}</Text>;
      })}
    </Box>
  );
}
