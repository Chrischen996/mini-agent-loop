import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { ChatMessage, ThinkingDisplayMode } from "../state.ts";
import { SubagentCard } from "./SubagentCard.tsx";
import { TUI_COLORS as C } from "../theme.ts";
import { selectMessageViewport } from "../message-viewport.ts";
import { MarkdownText } from "./MarkdownText.tsx";
import { toMessageRenderModel } from "../render-model.ts";
import { toolVisualName } from "../tool-lines.ts";
import { thinkingRenderLines, thinkingVisibleLines } from "../thinking-lines.ts";
import { noticeText, noticeTitle, statusLabel, toolArgumentSummary } from "../claude-style.ts";
import { isSubagentProtocolText, isSubagentToolName } from "../subagent-lines.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

function previewLines(text: string, max = 10): string[] {
  const lines = text.split("\n");
  const visible = lines.slice(0, max);
  if (lines.length > max) visible.push(`… (${lines.length - max} more lines)`);
  return visible;
}

// ─── ThinkingBlock ───────────────────────────────────────────────────────────

type ThinkingBlockProps = {
  content: string;
  isStreaming?: boolean;
  mode: ThinkingDisplayMode;
  /** Force full expand for this block (per-message override). */
  forceExpanded?: boolean;
  focused?: boolean;
};

/**
 * Collapsible extended-thinking display.
 *
 * - hidden: nothing
 * - summary: a compact expand hint
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

  const visibleModel = thinkingVisibleLines(content, { mode, isStreaming, forceExpanded });
  const showFull = visibleModel.expanded;

  // Claude Code keeps thinking as a quiet transcript block. It does not put
  // reasoning inside a rounded card or expose token/character counters in the
  // message feed; the expand hint is the only extra chrome in collapsed mode.
  if (!showFull) {
    return (
      <Box marginTop={0}>
        <Text color={focused ? C.selection : C.thinking} dimColor italic>
          ∴ Thinking ▸
        </Text>
      </Box>
    );
  }

  const body = thinkingRenderLines(content, { mode, isStreaming, forceExpanded }).map((line) => (
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
      marginTop={0}
      marginBottom={0}
      width="100%"
    >
      <Text color={focused ? C.selection : C.thinking} dimColor italic>∴ Thinking…</Text>
      <Box paddingLeft={2} flexDirection="column">
        {body}
      </Box>
    </Box>
  );
}

// ─── tool activity ───────────────────────────────────────────────────────────

// ─── dispatcher ──────────────────────────────────────────────────────────────

function ToolCallRow({ msg }: { msg: Extract<ChatMessage, { kind: "tool_call" }> }): React.ReactElement {
  const isRunning = msg.status === "running";
  const isError = msg.status === "error";
  const argument = toolArgumentSummary(msg.name, msg.rawArgs, msg.args).replace(/^\$\s*/, "");
  const resultLines = msg.result ? previewLines(msg.result, 15) : [];
  // Keep the activity marker expressive while the tool label stays readable;
  // Claude Code does not turn an entire command row amber just because it is
  // still running.
  const markerColor = isError ? C.error : isRunning ? C.running : C.primary;

  // Match Claude Code's AssistantToolUseMessage/MessageResponse pair:
  // one compact tool-use row followed by a single nested result gutter.
  return (
    <Box flexDirection="column" marginTop={0} marginBottom={0}>
      <Box flexDirection="row">
        <Text color={markerColor} bold>{isError ? "✗" : "⏺"} </Text>
        <Text color={isError ? C.error : C.info} bold>{toolVisualName(msg.name)}</Text>
        {argument ? <Text color={C.assistant}>({argument})</Text> : null}
      </Box>
      {resultLines.length > 0 ? (
        <Box flexDirection="column" marginLeft={2}>
          {resultLines.map((line, index) => (
            <Text key={index} color={isError ? C.error : C.muted} dimColor wrap="truncate-end">
              {index === 0 ? "⎿ " : "   "}{line}
            </Text>
          ))}
        </Box>
      ) : isRunning ? (
        <Text color={C.muted} dimColor>  ⎿ Running…</Text>
      ) : null}
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
  /** Match Claude Code by leaving clipped history unobstructed. */
  showHistoryHints?: boolean;
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
  status = "Thinking…",
  maxMessages = 200,
  availableHeight = 20,
  width = 80,
  scrollOffset = 0,
  showHistoryHints = false,
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
    showHistoryHints,
  });

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
      {viewport.items.map((item) => {
        if (item.kind === "history_hint") {
          // Keep viewport accounting intact, but do not replace transcript
          // rows with a numeric history hint. Claude Code leaves the clipped
          // conversation unobstructed and exposes navigation through keys.
          return null;
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
                <Text color={C.running} dimColor>{statusLabel(status, true)}</Text>
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
                width="100%"
              >
                <Text backgroundColor={C.userBg} color={C.assistant} wrap="wrap">
                  <Text color={C.muted}>{visual.marker}</Text>{" "}{msg.displayText ?? msg.text}
                </Text>
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
          if (isSubagentProtocolText(msg.text)) return null;
          const focused = focusedMessageIndex === absoluteIndex;
          return (
            <ViewportSlice key={absoluteIndex} clipTop={item.clipTop} visibleHeight={item.visibleHeight}>
              <Box marginBottom={0} flexDirection="column" marginTop={1}>
                <Box flexDirection="row">
                  <Text color={focused ? C.running : C.assistant} bold>{focused ? "◆" : visual.marker} </Text>
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
          if (isSubagentToolName(msg.name)) return null;
          return <ViewportSlice key={msg.id} clipTop={item.clipTop} visibleHeight={item.visibleHeight}><ToolCallRow msg={msg} /></ViewportSlice>;
        }
        if (msg.kind === "notice") {
          return (
            <ViewportSlice key={absoluteIndex} clipTop={item.clipTop} visibleHeight={item.visibleHeight}>
              <Box flexDirection="column" paddingX={1}>
                {msg.title && (
                  <Text color={C.info} dimColor>
                    {"─".repeat(6)} {noticeTitle(msg.title)} {"─".repeat(6)}
                  </Text>
                )}
                <Text color={C.assistant}>{noticeText(msg.text)}</Text>
              </Box>
            </ViewportSlice>
          );
        }
        if (msg.kind === "subagent_call") {
          return <ViewportSlice key={msg.id} clipTop={item.clipTop} visibleHeight={item.visibleHeight}><SubagentCard msg={msg} width={width} /></ViewportSlice>;
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
