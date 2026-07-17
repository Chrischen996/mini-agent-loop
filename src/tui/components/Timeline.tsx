import React from "react";
import { Box, Text } from "ink";
import type { TimelineEvent } from "../state.ts";

type TimelineProps = {
  events: TimelineEvent[];
  maxVisible?: number;
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function iconColor(icon: TimelineEvent["icon"]): string {
  switch (icon) {
    case "✓":
      return "green";
    case "▶":
      return "yellow";
    case "✗":
      return "red";
    default:
      return "gray";
  }
}

export function Timeline({ events, maxVisible = 6 }: TimelineProps): React.ReactElement {
  const visible = events.slice(-maxVisible);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Box gap={1}>
        <Text color="yellow">📜</Text>
        <Text bold>时间线</Text>
        <Text dimColor>({events.length} 事件)</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {visible.length === 0 ? (
          <Text dimColor>暂无事件</Text>
        ) : (
          visible.map((ev) => (
            <Box key={ev.id} gap={1}>
              <Text dimColor>{formatTime(ev.timestamp)}</Text>
              <Text color={iconColor(ev.icon) as Parameters<typeof Text>[0]["color"]}>
                {ev.icon}
              </Text>
              <Text color="white">{ev.label}</Text>
              {ev.detail && (
                <Text dimColor wrap="truncate-end">
                  {ev.detail}
                </Text>
              )}
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
