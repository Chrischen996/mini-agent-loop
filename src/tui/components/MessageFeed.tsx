import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { ChatMessage } from "../state.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function previewLines(text: string, max = 10): string[] {
  const lines = text.split("\n");
  const visible = lines.slice(0, max);
  if (lines.length > max) visible.push(`… (${lines.length - max} more lines)`);
  return visible;
}

// ─── tool-specific views ─────────────────────────────────────────────────────

/** read – show file path + content lines */
function ReadView({ msg }: { msg: Extract<ChatMessage, { kind: "tool_call" }> }): React.ReactElement {
  const path = str(msg.rawArgs.path) || str(msg.rawArgs.file) || "…";
  const isRunning = msg.status === "running";
  const isError = msg.status === "error";
  const lines = msg.result ? previewLines(msg.result) : [];

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1}>
        {isRunning ? <Text color="yellow"><Spinner type="dots" /></Text>
          : <Text color={isError ? "red" : "green"}>{isError ? "✗" : "✓"}</Text>}
        <Text dimColor>read</Text>
        <Text color="cyan">{path}</Text>
        {msg.durationMs !== undefined && <Text dimColor>({msg.durationMs}ms)</Text>}
      </Box>
      {!isRunning && lines.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {lines.map((line, i) => (
            <Text key={i} dimColor wrap="truncate-end">{line}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

/** bash – show command + stdout */
function BashView({ msg }: { msg: Extract<ChatMessage, { kind: "tool_call" }> }): React.ReactElement {
  const cmd = str(msg.rawArgs.command) || str(msg.rawArgs.cmd) || str(msg.rawArgs.input) || "…";
  const isRunning = msg.status === "running";
  const isError = msg.status === "error";
  const outputLines = msg.result ? previewLines(msg.result, 15) : [];

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1}>
        {isRunning ? <Text color="yellow"><Spinner type="dots" /></Text>
          : <Text color={isError ? "red" : "green"}>{isError ? "✗" : "✓"}</Text>}
        <Text dimColor>$</Text>
        <Text color="white" bold>{cmd}</Text>
        {msg.durationMs !== undefined && <Text dimColor>({msg.durationMs}ms)</Text>}
      </Box>
      {!isRunning && outputLines.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {outputLines.map((line, i) => (
            <Text key={i} color={isError ? "red" : "white"} dimColor wrap="truncate-end">{line}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

/** write / edit – show file path + first few lines of content */
function FileWriteView({ msg }: { msg: Extract<ChatMessage, { kind: "tool_call" }> }): React.ReactElement {
  const path = str(msg.rawArgs.path) || str(msg.rawArgs.file) || "…";
  const isEdit = msg.name === "edit";
  const isRunning = msg.status === "running";
  const isError = msg.status === "error";

  // For write, preview the first few lines of content arg
  const contentArg = str(msg.rawArgs.content);
  const previewSrc = contentArg ? previewLines(contentArg, 5) : [];

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1}>
        {isRunning ? <Text color="yellow"><Spinner type="dots" /></Text>
          : <Text color={isError ? "red" : "green"}>{isError ? "✗" : "✓"}</Text>}
        <Text dimColor>{isEdit ? "edit" : "write"}</Text>
        <Text color="cyan">{path}</Text>
        {msg.durationMs !== undefined && <Text dimColor>({msg.durationMs}ms)</Text>}
      </Box>
      {!isRunning && previewSrc.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {previewSrc.map((line, i) => (
            <Text key={i} dimColor wrap="truncate-end">{line}</Text>
          ))}
        </Box>
      )}
      {!isRunning && msg.result && (
        <Box marginLeft={2}>
          <Text color={isError ? "red" : "green"} dimColor>{msg.result}</Text>
        </Box>
      )}
    </Box>
  );
}

/** grep / search – show pattern + match count + first lines */
function GrepView({ msg }: { msg: Extract<ChatMessage, { kind: "tool_call" }> }): React.ReactElement {
  const pattern = str(msg.rawArgs.pattern) || str(msg.rawArgs.regex) || str(msg.rawArgs.query) || "…";
  const searchPath = str(msg.rawArgs.path) || ".";
  const isRunning = msg.status === "running";
  const isError = msg.status === "error";

  const resultLines = msg.result ? previewLines(msg.result, 8) : [];
  const matchCount = msg.result
    ? (msg.result.match(/\n/g) ?? []).length + 1
    : 0;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1}>
        {isRunning ? <Text color="yellow"><Spinner type="dots" /></Text>
          : <Text color={isError ? "red" : "green"}>{isError ? "✗" : "✓"}</Text>}
        <Text dimColor>grep</Text>
        <Text color="yellow">{pattern}</Text>
        <Text dimColor>in</Text>
        <Text color="cyan">{searchPath}</Text>
        {!isRunning && !isError && <Text dimColor>({matchCount} lines)</Text>}
        {msg.durationMs !== undefined && <Text dimColor>({msg.durationMs}ms)</Text>}
      </Box>
      {!isRunning && resultLines.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {resultLines.map((line, i) => (
            <Text key={i} dimColor wrap="truncate-end">{line}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

/** find / ls – show path + file listing */
function FileListView({ msg }: { msg: Extract<ChatMessage, { kind: "tool_call" }> }): React.ReactElement {
  const path = str(msg.rawArgs.path) || str(msg.rawArgs.dir) || ".";
  const isRunning = msg.status === "running";
  const isError = msg.status === "error";
  const items = msg.result ? previewLines(msg.result, 12) : [];

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1}>
        {isRunning ? <Text color="yellow"><Spinner type="dots" /></Text>
          : <Text color={isError ? "red" : "green"}>{isError ? "✗" : "✓"}</Text>}
        <Text dimColor>{msg.name}</Text>
        <Text color="cyan">{path}/</Text>
        {msg.durationMs !== undefined && <Text dimColor>({msg.durationMs}ms)</Text>}
      </Box>
      {!isRunning && items.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {items.map((item, i) => (
            <Text key={i} dimColor wrap="truncate-end">{item}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

/** fallback for unknown tools */
function GenericView({ msg }: { msg: Extract<ChatMessage, { kind: "tool_call" }> }): React.ReactElement {
  const isRunning = msg.status === "running";
  const isError = msg.status === "error";
  const resultLines = msg.result ? previewLines(msg.result, 6) : [];

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1}>
        {isRunning ? <Text color="yellow"><Spinner type="dots" /></Text>
          : <Text color={isError ? "red" : "green"}>{isError ? "✗" : "✓"}</Text>}
        <Text color={isRunning ? "yellow" : isError ? "red" : "green"} bold>{msg.name}</Text>
        {msg.durationMs !== undefined && <Text dimColor>({msg.durationMs}ms)</Text>}
      </Box>
      {msg.args && (
        <Box marginLeft={2}>
          <Text dimColor wrap="truncate-end">{msg.args}</Text>
        </Box>
      )}
      {!isRunning && resultLines.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {resultLines.map((line, i) => (
            <Text key={i} color={isError ? "red" : "white"} dimColor wrap="truncate-end">{line}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

// ─── dispatcher ──────────────────────────────────────────────────────────────

function ToolCallRow({ msg }: { msg: Extract<ChatMessage, { kind: "tool_call" }> }): React.ReactElement {
  switch (msg.name) {
    case "read":
      return <ReadView msg={msg} />;
    case "bash":
      return <BashView msg={msg} />;
    case "write":
    case "edit":
      return <FileWriteView msg={msg} />;
    case "grep":
    case "search":
      return <GrepView msg={msg} />;
    case "find":
    case "ls":
    case "list":
      return <FileListView msg={msg} />;
    default:
      return <GenericView msg={msg} />;
  }
}

// ─── main feed ───────────────────────────────────────────────────────────────

type MessageFeedProps = {
  messages: ChatMessage[];
  streamingText: string;
  maxMessages?: number;
};

export function MessageFeed({ messages, streamingText, maxMessages = 100 }: MessageFeedProps): React.ReactElement {
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
