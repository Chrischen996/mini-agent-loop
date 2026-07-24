import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { ChatMessage, SubagentInnerEvent } from "../state.ts";

type SubagentCallMessage = Extract<ChatMessage, { kind: "subagent_call" }>;

type SubagentCardProps = {
  msg: SubagentCallMessage;
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function InnerEventRow({ event }: { event: SubagentInnerEvent }): React.ReactElement {
  return (
    <Box gap={1}>
      <Text dimColor wrap="truncate-end">
        {event.label}
        {event.detail ? ` — ${event.detail}` : ""}
      </Text>
    </Box>
  );
}

/**
 * SubagentCard renders a subagent invocation in the TUI message feed.
 *
 * Inspired by Cline's subagent orchestration UI:
 * - Rounded border with status-dependent color
 * - Task description in quotes
 * - Statistics line (tool calls · cost/tokens · duration)
 * - Expandable inner event log ("> Show output")
 */
export function SubagentCard({ msg }: SubagentCardProps): React.ReactElement {
  const isRunning = msg.status === "running";
  const isError = msg.status === "error";
  const borderColor = isError ? "red" : isRunning ? "yellow" : "green";

  const depthLabel = msg.depth > 1 ? ` (depth ${msg.depth})` : "";
  const profileLabel = msg.profile ? ` [${msg.profile}]` : "";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      marginBottom={0}
    >
      {/* Header: icon + label + profile + duration */}
      <Box gap={1} justifyContent="space-between">
        <Box gap={1}>
          {isRunning ? (
            <Text color="yellow">
              <Spinner type="dots" />
            </Text>
          ) : (
            <Text color={isError ? "red" : "green"}>
              {isError ? "✗" : "✓"}
            </Text>
          )}
          <Text bold color={isRunning ? "yellow" : isError ? "red" : "green"}>
            Sub-Agent{depthLabel}{profileLabel}
          </Text>
        </Box>
        <Box gap={1}>
          {msg.toolCallCount > 0 && (
            <Text dimColor>{msg.toolCallCount} tool{msg.toolCallCount > 1 ? "s" : ""}</Text>
          )}
          {msg.turns !== undefined && msg.turns > 0 && (
            <Text dimColor>· {msg.turns} turn{msg.turns > 1 ? "s" : ""}</Text>
          )}
          {msg.totalTokens !== undefined && msg.totalTokens > 0 && (
            <Text dimColor>· {msg.totalTokens} tokens</Text>
          )}
          {msg.durationMs !== undefined && (
            <Text dimColor>· {formatDuration(msg.durationMs)}</Text>
          )}
        </Box>
      </Box>

      {/* Task description */}
      <Box marginLeft={2}>
        <Text color="white" wrap="wrap">
          &quot;{msg.task}&quot;
        </Text>
      </Box>

      {/* Live status: show latest inner event during running */}
      {isRunning && msg.innerEvents.length > 0 && !msg.expanded && (
        <Box marginLeft={2} marginTop={0} gap={1}>
          <Text color="yellow" dimColor>
            ↳ {msg.innerEvents[msg.innerEvents.length - 1]!.label}
          </Text>
        </Box>
      )}

      {/* Result preview (when done) */}
      {!isRunning && msg.result && !msg.expanded && (
        <Box marginLeft={2} marginTop={0}>
          <Text dimColor wrap="truncate-end">
            {msg.result.replace(/\s+/g, " ").trim().slice(0, 200)}
            {msg.result.length > 200 ? "…" : ""}
          </Text>
        </Box>
      )}

      {/* Expanded inner events (available both during running and after) */}
      {msg.expanded && msg.innerEvents.length > 0 && (
        <Box flexDirection="column" marginLeft={2} marginTop={0}>
          <Text dimColor>── inner events ──</Text>
          {msg.innerEvents.map((evt, i) => (
            <InnerEventRow key={i} event={evt} />
          ))}
          {isRunning && (
            <Box gap={1}>
              <Text color="yellow"><Spinner type="dots" /></Text>
              <Text dimColor>waiting for next event...</Text>
            </Box>
          )}
        </Box>
      )}

      {/* Expand/collapse hint (available during running too) */}
      {msg.innerEvents.length > 0 && (
        <Box marginLeft={2}>
          <Text color={borderColor} dimColor>
            {msg.expanded ? "▾ Hide output" : `▸ Show output (${msg.innerEvents.length} events)`}
          </Text>
        </Box>
      )}
    </Box>
  );
}
