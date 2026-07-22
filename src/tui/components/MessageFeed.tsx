import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { ChatMessage, ThinkingDisplayMode } from "../state.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

const THINKING_SUMMARY_LINES = 1;
const THINKING_AUTO_COLLAPSE_LINES = 15;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Format assistant message text for better readability in TUI.
 * Enhances markdown-style formatting with terminal-friendly alternatives.
 */
function formatAssistantText(raw: string): string {
  return raw
    // ## Headers → with separator lines
    .replace(/^## (.+)$/gm, "\n━━━ $1 ━━━")
    // ### Subheaders → with arrow prefix
    .replace(/^### (.+)$/gm, "\n▸ $1")
    // **bold** → brackets (more visible in plain text)
    .replace(/\*\*([^*]+)\*\*/g, "【$1】")
    // Horizontal rule --- → full-width line
    .replace(/^---+$/gm, "─".repeat(60));
}

function previewLines(text: string, max = 10): string[] {
  const lines = text.split("\n");
  const visible = lines.slice(0, max);
  if (lines.length > max) visible.push(`… (${lines.length - max} more lines)`);
  return visible;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k tokens`;
  return `${tokens} tokens`;
}

// ─── ThinkingBlock ───────────────────────────────────────────────────────────

type ThinkingBlockProps = {
  content: string;
  isStreaming?: boolean;
  mode: ThinkingDisplayMode;
  /** Force full expand for this block (per-message override). */
  forceExpanded?: boolean;
  focused?: boolean;
  onToggle?: () => void;
};

/**
 * Collapsible extended-thinking display.
 *
 * - hidden: nothing
 * - summary: first N lines + token count + expand hint
 * - full: complete content
 *
 * Streaming content auto-collapses after THINKING_AUTO_COLLAPSE_LINES lines
 * unless mode is already "full" or forceExpanded is true.
 */
export function ThinkingBlock({
  content,
  isStreaming = false,
  mode,
  forceExpanded = false,
  focused = false,
}: ThinkingBlockProps): React.ReactElement | null {
  if (mode === "hidden" && !forceExpanded) return null;
  if (!content) return null;

  const lines = content.split("\n");
  const tokenCount = estimateTokens(content);
  const streamingShouldCollapse =
    isStreaming &&
    !forceExpanded &&
    mode !== "full" &&
    lines.length > THINKING_AUTO_COLLAPSE_LINES;
  const showFull =
    forceExpanded ||
    mode === "full" ||
    (mode === "summary" && !isStreaming && lines.length <= THINKING_SUMMARY_LINES) ||
    (isStreaming && !streamingShouldCollapse && mode !== "summary");

  // Distinctive panel: magenta frame + status badge.
  // Streaming = yellow energy; focused = cyan highlight; idle = magenta signature.
  const frameColor = focused ? "cyan" : isStreaming ? "yellow" : "magenta";
  const badgeBg = focused ? "cyan" : isStreaming ? "yellow" : "magenta";
  const badgeFg = "black";
  const badgeLabel = isStreaming ? " THINKING… " : showFull ? " THINK " : " THINK ▸ ";
  const actionHint = !isStreaming
    ? (showFull
      ? (focused ? "Alt+T collapse" : "Alt+T")
      : (focused ? "Alt+T expand" : "Alt+T"))
    : "streaming";

  const body = !showFull
    ? (() => {
        const preview = lines.slice(0, THINKING_SUMMARY_LINES).join("\n");
        const remaining = Math.max(0, lines.length - THINKING_SUMMARY_LINES);
        return (
          <>
            <Text color="white" dimColor wrap="wrap">{preview}</Text>
            {remaining > 0 && (
              <Text color="magenta" dimColor>
                ··· {remaining} more lines{isStreaming ? " · live" : ""}
              </Text>
            )}
          </>
        );
      })()
    : <Text color="white" dimColor wrap="wrap">{content}</Text>;

  return (
    <Box
      flexDirection="column"
      marginY={0}
      paddingX={1}
      borderStyle="round"
      borderColor={frameColor}
    >
      {/* Title bar */}
      <Box justifyContent="space-between" marginBottom={0}>
        <Box gap={1}>
          <Text backgroundColor={badgeBg} color={badgeFg} bold>
            {badgeLabel}
          </Text>
          <Text color={frameColor} dimColor={!focused && !isStreaming}>
            {formatTokenCount(tokenCount)}
          </Text>
          {isStreaming && (
            <Text color="yellow">
              <Spinner type="dots" />
            </Text>
          )}
        </Box>
        <Text color={frameColor} dimColor>
          {actionHint}
        </Text>
      </Box>
      {/* Divider-ish spacing + body */}
      <Box flexDirection="column" marginTop={0}>
        {body}
      </Box>
    </Box>
  );
}

// ─── tool-specific views ─────────────────────────────────────────────────────

/** read – show file path + content lines */
function ReadView({ msg }: { msg: Extract<ChatMessage, { kind: "tool_call" }> }): React.ReactElement {
  const path = str(msg.rawArgs.path) || str(msg.rawArgs.file) || "…";
  const isRunning = msg.status === "running";
  const isError = msg.status === "error";
  const lines = msg.result ? previewLines(msg.result) : [];

  return (
    <Box flexDirection="column" marginBottom={0}>
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
    <Box flexDirection="column" marginBottom={0}>
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
    <Box flexDirection="column" marginBottom={0}>
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
    <Box flexDirection="column" marginBottom={0}>
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
    <Box flexDirection="column" marginBottom={0}>
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
    <Box flexDirection="column" marginBottom={0}>
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
  streamingReasoning?: string;
  /** @deprecated Prefer thinkingMode. Kept for backward compatibility. */
  showThinking?: boolean;
  thinkingMode?: ThinkingDisplayMode;
  expandedThinking?: number[];
  focusedMessageIndex?: number;
  busy?: boolean;
  status?: string;
  maxMessages?: number;
};

export function MessageFeed({
  messages,
  streamingText,
  streamingReasoning = "",
  showThinking = true,
  thinkingMode,
  expandedThinking = [],
  focusedMessageIndex = -1,
  busy = false,
  status = "思考中...",
  maxMessages = 100,
}: MessageFeedProps): React.ReactElement {
  const effectiveMode: ThinkingDisplayMode =
    thinkingMode ?? (showThinking ? "summary" : "hidden");
  const expandedSet = new Set(expandedThinking);
  // Slice keeps last N messages; map absolute indices for focus/expand state.
  const startIndex = Math.max(0, messages.length - maxMessages);
  const visible = messages.slice(startIndex);

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {visible.map((msg, offset) => {
        const absoluteIndex = startIndex + offset;
        if (msg.kind === "user") {
          return (
            <Box key={absoluteIndex} marginBottom={0} gap={1}>
              <Text color="green" bold>{">"}</Text>
              <Text color="white">{msg.text}</Text>
            </Box>
          );
        }
        if (msg.kind === "assistant") {
          const formattedText = msg.text ? formatAssistantText(msg.text) : "";
          return (
            <Box key={absoluteIndex} marginBottom={0} flexDirection="column">
              {msg.reasoning && (
                <ThinkingBlock
                  content={msg.reasoning}
                  mode={effectiveMode}
                  forceExpanded={expandedSet.has(absoluteIndex)}
                  focused={focusedMessageIndex === absoluteIndex}
                />
              )}
              {formattedText && <Text color="cyan" wrap="wrap">{formattedText}</Text>}
            </Box>
          );
        }
        if (msg.kind === "tool_call") {
          return <ToolCallRow key={msg.id} msg={msg} />;
        }
        if (msg.kind === "error") {
          return (
            <Box key={absoluteIndex} marginBottom={0}>
              <Text color="red">✗ {msg.text}</Text>
            </Box>
          );
        }
        return null;
      })}

      {/* Live streaming reasoning */}
      {streamingReasoning ? (
        <ThinkingBlock
          content={streamingReasoning}
          isStreaming
          mode={effectiveMode}
        />
      ) : null}

      {/* Live streaming answer text */}
      {streamingText ? (
        <Box marginBottom={0} flexDirection="column">
          <Text color="cyan" wrap="wrap">{streamingText}</Text>
        </Box>
      ) : null}

      {busy && !streamingText && !streamingReasoning ? (
        <Box marginBottom={0} gap={1}>
          <Text color="yellow"><Spinner type="dots" /></Text>
          <Text dimColor>{status}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
