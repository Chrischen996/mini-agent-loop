import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { ChatMessage, ThinkingDisplayMode } from "../state.ts";
import { SubagentCard } from "./SubagentCard.tsx";
import { TUI_COLORS as C } from "../theme.ts";
import { selectMessageViewport } from "../message-viewport.ts";
import { MarkdownText } from "./MarkdownText.tsx";
import { toMessageRenderModel } from "../render-model.ts";
import { toolDisplayName, toolStatusIcon } from "../tool-lines.ts";
import { thinkingRenderLines, thinkingVisibleLines } from "../thinking-lines.ts";

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

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k tokens`;
  return `${tokens} tokens`;
}

function formatCharCount(chars: number): string {
  if (chars >= 1000) return `${(chars / 1000).toFixed(1)}k chars`;
  return `${chars} chars`;
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

  const tokenCount = estimateTokens(content);
  const visibleModel = thinkingVisibleLines(content, { mode, isStreaming, forceExpanded });
  const showFull = visibleModel.expanded;

  // Distinctive panel: magenta frame + status badge.
  // Streaming = yellow energy; focused = cyan highlight; idle = magenta signature.
  const frameColor = focused ? C.selection : isStreaming ? C.running : C.thinking;
  const badgeBg = focused ? C.selection : isStreaming ? C.running : C.thinking;
  const badgeFg = C.badgeText;
  const badgeLabel = isStreaming ? " THINKING… " : showFull ? " THINK " : " THINK ▸ ";
  const charCount = content.length;
  const streamInfo = isStreaming ? ` · ${formatCharCount(charCount)} streaming` : "";
  const actionHint = !isStreaming
    ? (showFull
      ? (focused ? "Alt+T collapse" : "Alt+T")
      : (focused ? "Alt+T expand" : "Alt+T"))
    : `${formatCharCount(charCount)}`;

  const body = thinkingRenderLines(content, { mode, isStreaming, forceExpanded, streamInfo }).map((line) => (
    <Text
      key={line.key}
      color={line.style === "thinking" ? C.thinking : line.style === "muted" ? C.muted : C.assistant}
      dimColor={line.dim}
      wrap="wrap"
    >
      {line.text}
    </Text>
  ));

  return (
    <Box
      flexDirection="column"
      marginY={0}
      marginBottom={0}
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
            <Text color={C.running}>
              <Spinner type="dots" />
            </Text>
          )}
        </Box>
          <Text color={frameColor} dimColor>
          {actionHint}
        </Text>
      </Box>
      {/* Body with visual separation */}
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
        {isRunning ? <Text color={C.running}><Spinner type="dots" /></Text>
          : <Text color={isError ? C.error : C.success}>{toolStatusIcon(msg.status)}</Text>}
        <Text dimColor>read</Text>
        <Text color={C.info}>{path}</Text>
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
        {isRunning ? <Text color={C.running}><Spinner type="dots" /></Text>
          : <Text color={isError ? C.error : C.success}>{toolStatusIcon(msg.status)}</Text>}
        <Text dimColor>$</Text>
        <Text color={C.assistant} bold>{cmd}</Text>
        {msg.durationMs !== undefined && <Text dimColor>({msg.durationMs}ms)</Text>}
      </Box>
      {!isRunning && outputLines.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {outputLines.map((line, i) => (
            <Text key={i} color={isError ? C.error : C.assistant} dimColor wrap="truncate-end">{line}</Text>
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
        {isRunning ? <Text color={C.running}><Spinner type="dots" /></Text>
          : <Text color={isError ? C.error : C.success}>{toolStatusIcon(msg.status)}</Text>}
        <Text dimColor>{isEdit ? "edit" : "write"}</Text>
        <Text color={C.info}>{path}</Text>
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
          <Text color={isError ? C.error : C.success} dimColor>{msg.result}</Text>
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
        {isRunning ? <Text color={C.running}><Spinner type="dots" /></Text>
          : <Text color={isError ? C.error : C.success}>{isError ? "✗" : "✓"}</Text>}
        <Text dimColor>grep</Text>
        <Text color={C.running}>{pattern}</Text>
        <Text dimColor>in</Text>
        <Text color={C.info}>{searchPath}</Text>
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
        {isRunning ? <Text color={C.running}><Spinner type="dots" /></Text>
          : <Text color={isError ? C.error : C.success}>{isError ? "✗" : "✓"}</Text>}
        <Text dimColor>{toolDisplayName(msg.name)}</Text>
        <Text color={C.info}>{path}/</Text>
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
        {isRunning ? <Text color={C.running}><Spinner type="dots" /></Text>
          : <Text color={isError ? C.error : C.success}>{isError ? "✗" : "✓"}</Text>}
        <Text color={isRunning ? C.running : isError ? C.error : C.success} bold>{msg.name}</Text>
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
            <Text key={i} color={isError ? C.error : C.assistant} dimColor wrap="truncate-end">{line}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

// ─── dispatcher ──────────────────────────────────────────────────────────────

function ToolCallRow({ msg }: { msg: Extract<ChatMessage, { kind: "tool_call" }> }): React.ReactElement {
  let content: React.ReactElement;
  switch (msg.name) {
    case "read":
      content = <ReadView msg={msg} />;
      break;
    case "bash":
      content = <BashView msg={msg} />;
      break;
    case "write":
    case "edit":
      content = <FileWriteView msg={msg} />;
      break;
    case "grep":
    case "search":
      content = <GrepView msg={msg} />;
      break;
    case "find":
    case "ls":
    case "list":
      content = <FileListView msg={msg} />;
      break;
    default:
      content = <GenericView msg={msg} />;
  }
  return (
    <Box flexDirection="row" marginTop={0} marginBottom={0}>
      <Text color={C.gutter}>⎿ </Text>
      <Box flexDirection="column" flexGrow={1}>{content}</Box>
    </Box>
  );
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
  /** Rows available for the feed after chrome (header/input/status). */
  availableHeight?: number;
  /** Terminal width used for wrap-aware height estimates. */
  width?: number;
  /**
   * Number of trailing history messages hidden below the viewport.
   * 0 = stick to bottom.
   */
  scrollOffset?: number;
};

function ViewportSlice({
  clipTop,
  visibleHeight,
  children,
}: {
  clipTop: number;
  visibleHeight: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box height={visibleHeight} flexShrink={0} overflow="hidden">
      <Box flexDirection="column" marginTop={-clipTop}>
        {children}
      </Box>
    </Box>
  );
}

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
  maxMessages = 200,
  availableHeight = 20,
  width = 80,
  scrollOffset = 0,
}: MessageFeedProps): React.ReactElement {
  const effectiveMode: ThinkingDisplayMode =
    thinkingMode ?? (showThinking ? "summary" : "hidden");
  const expandedSet = new Set(expandedThinking);
  
  const viewport = selectMessageViewport({
    messages,
    streamingText,
    streamingReasoning,
    busy,
    thinkingMode: effectiveMode,
    expandedThinking,
    scrollOffset,
    availableHeight,
    width,
    maxMessages,
  });

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
      {viewport.items.map((item, itemIndex) => {
        if (item.kind === "history_hint") {
          return (
            <Box key={`hint-${itemIndex}`} marginBottom={0}>
              <Text color={C.info} dimColor>
                {item.direction === "above"
                  ? `↑ 还有 ${item.hiddenRows} 行`
                  : `↓ 还有 ${item.hiddenRows} 行 · Ctrl+G 回到底部`}
              </Text>
            </Box>
          );
        }
        if (item.kind === "streaming_reasoning") {
          return (
            <ViewportSlice key="streaming-reasoning" clipTop={item.clipTop} visibleHeight={item.visibleHeight}>
              <ThinkingBlock content={streamingReasoning} isStreaming={busy} mode={effectiveMode} />
            </ViewportSlice>
          );
        }
        if (item.kind === "streaming_text") {
          return (
            <ViewportSlice key="streaming-text" clipTop={item.clipTop} visibleHeight={item.visibleHeight}>
              <Box flexDirection="row">
                <Text color={C.primary} bold>⏺ </Text>
                <Text color={C.assistant} wrap="wrap">{streamingText}</Text>
              </Box>
            </ViewportSlice>
          );
        }
        if (item.kind === "busy_status") {
          return (
            <ViewportSlice key="busy-status" clipTop={item.clipTop} visibleHeight={item.visibleHeight}>
              <Box marginBottom={0} gap={1}>
                <Text color={C.running}><Spinner type="dots" /></Text>
                <Text color={C.running} dimColor>{status}</Text>
              </Box>
            </ViewportSlice>
          );
        }

        const msg = item.message;
        const absoluteIndex = item.index;
        const visual = toMessageRenderModel(msg);
        if (msg.kind === "user") {
          return (
            <ViewportSlice key={absoluteIndex} clipTop={item.clipTop} visibleHeight={item.visibleHeight}>
              <Box
                marginBottom={0}
                flexDirection="column"
                paddingX={1}
                marginTop={1}
              >
                <Box gap={1}>
                  <Text color={C.user} bold>{visual.marker}</Text>
                  <Text color={C.assistant}>{msg.displayText ?? msg.text}</Text>
                </Box>
                {msg.images?.length ? (
                  <Box marginLeft={2} marginTop={0} gap={1}>
                    {msg.images.map((image) => (
                      <Text key={image.path} color={C.info}>[image: {image.path.split("/").pop()}]</Text>
                    ))}
                  </Box>
                ) : null}
              </Box>
            </ViewportSlice>
          );
        }
        if (msg.kind === "assistant") {
          return (
            <ViewportSlice key={absoluteIndex} clipTop={item.clipTop} visibleHeight={item.visibleHeight}>
              <Box marginBottom={0} flexDirection="column" marginTop={1}>
                <Box flexDirection="row">
                  <Text color={C.primary} bold>{visual.marker} </Text>
                  <Box flexDirection="column" flexGrow={1}>
                    {msg.reasoning && (
                      <ThinkingBlock
                        content={msg.reasoning}
                        mode={effectiveMode}
                        forceExpanded={expandedSet.has(absoluteIndex)}
                        focused={focusedMessageIndex === absoluteIndex}
                      />
                    )}
                    {msg.text && <MarkdownText text={msg.text} />}
                  </Box>
                </Box>
              </Box>
            </ViewportSlice>
          );
        }
        if (msg.kind === "tool_call") {
          return <ViewportSlice key={msg.id} clipTop={item.clipTop} visibleHeight={item.visibleHeight}><ToolCallRow msg={msg} /></ViewportSlice>;
        }
        if (msg.kind === "notice") {
          return (
            <ViewportSlice key={absoluteIndex} clipTop={item.clipTop} visibleHeight={item.visibleHeight}>
              <Box flexDirection="column" paddingX={1}>
                {msg.title && (
                  <Text color={C.info} dimColor>
                    {"─".repeat(6)} {msg.title} {"─".repeat(6)}
                  </Text>
                )}
                <Text color={C.assistant}>{msg.text}</Text>
              </Box>
            </ViewportSlice>
          );
        }
        if (msg.kind === "subagent_call") {
          return <ViewportSlice key={msg.id} clipTop={item.clipTop} visibleHeight={item.visibleHeight}><SubagentCard msg={msg} /></ViewportSlice>;
        }
        if (msg.kind === "error") {
          return (
            <ViewportSlice key={absoluteIndex} clipTop={item.clipTop} visibleHeight={item.visibleHeight}>
              <Text color={C.error}>✗ {msg.text}</Text>
            </ViewportSlice>
          );
        }
        return null;
      })}
    </Box>
  );
}
