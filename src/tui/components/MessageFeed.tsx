import React from "react";
import { Box, Text } from "ink";
import { resolveSubagentMessage, type ChatMessage, type PendingPermissionState, type ThinkingDisplayMode } from "../state.ts";
import { TUI_COLORS as C } from "../theme.ts";
import { selectMessageViewport, type MessageHeightCache, type ViewportItem } from "../message-viewport.ts";
import type { PhysicalRow } from "../message-rows.ts";
import { activityPresentation, formatActivity, loadingGlyph, loadingMarkerBright, LOADING_FRAME_MS } from "../activity.ts";
import { statusLabel } from "../claude-style.ts";
import { hexToAnsi } from "../render-line-format.ts";
import { codeTokenAttrs, codeTokenColor, type CodeSpan } from "../code-highlight.ts";

/** Compose one SGR sequence for a highlighted token run. */
function spanCodes(span: CodeSpan): string {
  const attrs = codeTokenAttrs(span.kind);
  const codes: string[] = [];
  if (attrs.dim) codes.push("2");
  if (attrs.italic) codes.push("3");
  codes.push(hexToAnsi(codeTokenColor(span.kind)));
  return `\x1b[${codes.join(";")}m`;
}

// ─── physical rows ───────────────────────────────────────────────────────────

function rowColor(row: PhysicalRow): string | undefined {
  if (row.tone === "success") return C.success;
  if (row.tone === "running") return C.running;
  if (row.tone === "error" || row.style === "error") return C.error;
  if (row.style === "thinking") return C.thinking;
  if (row.style === "tool" || row.style === "todo") return C.info;
  if (row.style === "user") return C.user;
  if (row.style === "border" || row.style === "muted") return C.muted;
  return undefined;
}

/**
 * One terminal row, pre-wrapped by the shared projection.
 *
 * `wrap="truncate-end"` is a defensive bound only: rows arrive already
 * wrapped at the feed width, so nothing should ever exceed the column budget.
 * The old layout let whole markdown trees overflow `hidden` boxes under
 * negative top margins; Ink applies only the innermost clip, which is how
 * scrolled history escaped its slice and overwrote other frame rows.
 */
const PhysicalRowText = React.memo(function PhysicalRowText({ row, marker }: { row: PhysicalRow; marker: string }): React.ReactElement {
  if (row.spans?.length) {
    return (
      <Text wrap="truncate-end">
        {marker}
        {row.spans.map((span, spanIndex) => {
          const attrs = codeTokenAttrs(span.kind);
          return (
            <Text key={spanIndex} color={codeTokenColor(span.kind)} dimColor={attrs.dim ?? false} italic={attrs.italic ?? false}>
              {span.text}
            </Text>
          );
        })}
      </Text>
    );
  }
  return (
    <Text
      color={rowColor(row)}
      dimColor={row.dim}
      bold={row.bold}
      italic={row.italic}
      wrap="truncate-end"
    >
      {marker}{row.text}
    </Text>
  );
});

// ─── live activity ───────────────────────────────────────────────────────────

function ActivityRow({
  status,
  streamingText,
  streamingReasoning,
  messages,
  toolById,
  activeToolId,
  pendingPermission,
  turnStartedAt,
  lastStreamAt,
  spinnerMessage,
  todoPanelVisible,
}: {
  status: string;
  streamingText: string;
  streamingReasoning: string;
  messages: ChatMessage[];
  toolById?: Readonly<Record<string, Extract<ChatMessage, { kind: "tool_call" }>>>;
  activeToolId?: string;
  pendingPermission?: PendingPermissionState;
  turnStartedAt?: number;
  lastStreamAt?: number;
  spinnerMessage?: string;
  todoPanelVisible?: boolean;
}): React.ReactElement {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), LOADING_FRAME_MS);
    return () => clearInterval(timer);
  }, []);
  const activity = activityPresentation({
    busy: true,
    status,
    streamingText,
    streamingReasoning,
    messages,
    toolById,
    activeToolId,
    pendingPermission,
    turnStartedAt,
    lastStreamAt,
    spinnerMessage,
    todoPanelVisible,
  }, { now });
  const markerColor = activity?.stalled
    ? C.error
    : loadingMarkerBright(now, turnStartedAt)
      ? C.running
      : C.muted;

  return (
    <Box marginBottom={0} gap={1} flexWrap="nowrap" minWidth={0}>
      <Text color={markerColor} bold>
        {loadingGlyph(now, turnStartedAt)}
      </Text>
      <Text color={activity?.stalled ? C.error : C.running} dimColor wrap="truncate-end">
        {activity ? formatActivity(activity) : statusLabel(status, true)}
      </Text>
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
  pendingPermission?: PendingPermissionState;
  turnStartedAt?: number;
  lastStreamAt?: number;
  /** Active Todo tip rendered inside the single loading row. */
  spinnerMessage?: string;
  /** True while TodoPanel is on screen and already names the active step. */
  todoPanelVisible?: boolean;
  maxMessages?: number;
  /**
   * First transcript index owned by the dynamic frame. Sealed rows already
   * live in the terminal's native scrollback via `<Static>` (inline layout
   * mode) and must not be re-rendered here.
   */
  historyStartIndex?: number;
  /** Document layout: live text renders the full-markdown projection minus streamed rows. */
  documentMode?: boolean;
  /** Rows of the streaming assistant projection already appended to the stream. */
  committedStreamingRows?: number;
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
  /** Optional per-message height cache shared with the App-level estimates. */
  heightCache?: MessageHeightCache;
  subagentById?: Readonly<Record<string, Extract<ChatMessage, { kind: "subagent_call" }>>>;
  subagentRevision?: number;
  subagentChange?: { id: string; index: number; revision: number };
  toolById?: Readonly<Record<string, Extract<ChatMessage, { kind: "tool_call" }>>>;
  toolRevision?: number;
  toolChange?: { id: string; index: number; revision: number };
  activeToolId?: string;
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
  status = "Thinking…",
  pendingPermission,
  turnStartedAt,
  lastStreamAt,
  spinnerMessage,
  todoPanelVisible = false,
  maxMessages = Number.MAX_SAFE_INTEGER,
  historyStartIndex = 0,
  documentMode = false,
  committedStreamingRows = 0,
  availableHeight = 20,
  width = 80,
  scrollOffset = 0,
  showHistoryHints = false,
  heightCache,
  subagentById,
  subagentRevision,
  subagentChange,
  toolById,
  toolRevision,
  toolChange,
  activeToolId,
}: MessageFeedProps): React.ReactElement {
  const effectiveMode: ThinkingDisplayMode =
    thinkingMode ?? (showThinking ? "summary" : "hidden");
  void resolveSubagentMessage;

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
    historyStartIndex,
    documentMode,
    committedStreamingRows,
    showHistoryHints,
    cache: heightCache,
    subagentById,
    subagentRevision,
    subagentChange,
    toolById,
    toolRevision,
    toolChange,
  });

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} width={width} minWidth={0} overflow="hidden">
      {/* Pinned to the newest rows the transcript stays bottom-anchored; the
          surplus rows the wrap-aware frame height may over-reserve are
          absorbed above the visible window so the last message remains
          directly above the input chrome. Scrolled-up windows instead carry
          the surplus below the slice so the visible rows start flush under
          the header. */}
      {viewport.pinnedToBottom ? <Box flexGrow={1} minHeight={0} /> : null}
      {viewport.items.map((item) => {
        if (item.kind === "history_hint") {
          // Show a thin 1-row hint so the user knows more content is available
          // above/below without obstructing the transcript.
          const label = item.direction === "above"
            ? `⌃ ${item.hiddenRows} lines above (PgUp to scroll)`
            : `⌄ ${item.hiddenRows} lines below (PgDn to scroll)`;
          return (
            <Text key={`history-hint-${item.direction}`} color={C.muted} dimColor wrap="truncate-end">
              {label}
            </Text>
          );
        }
        if (item.kind === "busy_status") {
          return (
            <React.Fragment key="busy-status">
              {item.rows.filter((row) => row.key.startsWith("live-gap")).map((row) => (
                <Text key={row.key}> </Text>
              ))}
              <ActivityRow
                status={status}
                streamingText={streamingText}
                streamingReasoning={streamingReasoning}
                messages={messages}
                toolById={toolById}
                activeToolId={activeToolId}
                pendingPermission={pendingPermission}
                turnStartedAt={turnStartedAt}
                lastStreamAt={lastStreamAt}
                spinnerMessage={spinnerMessage}
                todoPanelVisible={todoPanelVisible}
              />
            </React.Fragment>
          );
        }
        // Message / streaming blocks: physical rows are already wrapped and
        // sliced to the exact visible window, so each row renders once with
        // no nested overflow clipping and no negative margins.
        return (
          <React.Fragment key={item.kind === "message" ? item.index : item.kind}>
            {item.rows.map((row) => (
              <PhysicalRowText key={row.key} row={row} marker="" />
            ))}
          </React.Fragment>
        );
      })}
      {/* Scrolled-up windows keep the surplus below the slice so the visible
          rows start flush under the header instead of under a blank band. */}
      {viewport.pinnedToBottom ? null : <Box flexGrow={1} minHeight={0} />}
    </Box>
  );
}

/**
 * Render sealed transcript rows to self-contained ANSI text for the inline
 * layout's native-scrollback bursts. Each line carries its own SGR attributes
 * and a hard reset, so styling never bleeds between rows written raw to the
 * terminal (outside Ink's per-row erase pipeline). The leading space mirrors
 * the dynamic feed's `paddingX={1}`.
 */
export function formatSealedRowsText(rows: readonly PhysicalRow[]): string {
  const lines = rows.map((row) => {
    if (row.spans?.length) {
      const runs = row.spans.map((span) => `${spanCodes(span)}${span.text}`).join("");
      return `\x1b[0m ${runs}\x1b[0m`;
    }
    const codes: string[] = [];
    if (row.bold) codes.push("1");
    if (row.italic) codes.push("3");
    if (row.dim) codes.push("2");
    codes.push(hexToAnsi(rowColor(row) ?? C.assistant));
    return `\x1b[${codes.join(";")}m ${row.text}\x1b[0m`;
  });
  return `${lines.join("\n")}\n`;
}
