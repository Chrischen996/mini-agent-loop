import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { ChatMessage } from "../state.ts";

type MessageFeedProps = {
  messages: ChatMessage[];
  streamingText: string;
  maxMessages?: number;
};

function ToolCallRow({ msg }: { msg: Extract<ChatMessage, { kind: "tool_call" }> }): React.ReactElement {
  const isRunning = msg.status === "running";
  const isError = msg.status === "error";

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Tool header */}
      <Box gap={1}>
        {isRunning ? (
          <Text color="yellow"><Spinner type="dots" /></Text>
        ) : (
          <Text color={isError ? "red" : "green"}>{isError ? "✗" : "✓"}</Text>
        )}
        <Text color={isRunning ? "yellow" : isError ? "red" : "green"} bold>
          {msg.name}
        </Text>
        {msg.durationMs !== undefined && (
          <Text dimColor>({msg.durationMs}ms)</Text>
        )}
      </Box>
      {/* Args, dimmed */}
      {msg.args && (
        <Box marginLeft={2}>
          <Text dimColor wrap="truncate-end">{msg.args}</Text>
        </Box>
      )}
      {/* Result, collapsed to one line */}
      {msg.result && !isRunning && (
        <Box marginLeft={2}>
          <Text color={isError ? "red" : "white"} wrap="truncate-end">
            {msg.result}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function MessageFeed({ messages, streamingText, maxMessages = 50 }: MessageFeedProps): React.ReactElement {
  const visible = messages.slice(-maxMessages);

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {visible.map((msg, i) => {
        if (msg.kind === "user") {
          return (
            <Box key={i} marginBottom={1} gap={1}>
              <Text color="green" bold>{">"}</Text>
              <Text color="white">{msg.text}</Text>
            </Box>
          );
        }
        if (msg.kind === "assistant") {
          return (
            <Box key={i} marginBottom={1} flexDirection="column">
              <Text color="cyan" wrap="wrap">{msg.text}</Text>
            </Box>
          );
        }
        if (msg.kind === "tool_call") {
          return <ToolCallRow key={msg.id} msg={msg} />;
        }
        if (msg.kind === "error") {
          return (
            <Box key={i} marginBottom={1}>
              <Text color="red">✗ {msg.text}</Text>
            </Box>
          );
        }
        return null;
      })}

      {/* Live streaming assistant text */}
      {streamingText ? (
        <Box marginBottom={1} flexDirection="column">
          <Text color="cyan" wrap="wrap">{streamingText}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
