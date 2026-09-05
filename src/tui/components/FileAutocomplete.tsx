import React from "react";
import { Box, Text } from "ink";
import { TUI_COLORS as C } from "../theme.ts";
import type { PersistedSessionMeta } from "../../session-store.ts";
import { SESSION_PICKER_HINT } from "../session-serialization.ts";
import { PICKER_SELECTED_MARKER, PICKER_UNSELECTED_MARKER } from "../claude-style.ts";
import { formatContextWindow as formatContextWindowShared } from "../status-line.ts";

// ─── Command palette ─────────────────────────────────────────────────────────

// Re-exported so existing importers keep resolving the catalog from here while
// the data itself lives in the framework-neutral `slash-commands` module.
export { SLASH_COMMANDS, type CommandDef } from "../slash-commands.ts";
import { commandUsageColumn, type CommandDef } from "../slash-commands.ts";

type CommandPaletteProps = {
  filter: string;         // what the user typed after /
  selectedIndex: number;
  candidates: CommandDef[];
  maxVisible?: number;
  width?: number;
};

function visibleWindow<T>(items: T[], selectedIndex: number, maxVisible: number): { visible: T[]; start: number } {
  const count = Math.max(1, maxVisible);
  const start = Math.max(0, Math.min(selectedIndex - count + 1, items.length - count));
  return { visible: items.slice(start, start + count), start };
}

export function CommandPalette({ filter, selectedIndex, candidates, maxVisible = 6, width }: CommandPaletteProps): React.ReactElement | null {
  const { visible, start } = visibleWindow(candidates, selectedIndex, maxVisible);
  // Same column the ANSI palette and `/help` use, so descriptions line up.
  const usageColumn = commandUsageColumn(candidates);

  return (
    <Box flexDirection="column" paddingX={2} width={width} minWidth={0} overflow="hidden">
      <Text dimColor wrap="truncate-end">── Commands /{filter}</Text>
      {candidates.length === 0 && <Text color={C.running} wrap="truncate-end">No matching commands</Text>}
      {visible.map((cmd, i) => {
        const index = start + i;
        return (
        <Box key={cmd.name} gap={1} minWidth={0}>
          <Text color={index === selectedIndex ? C.running : undefined} bold={index === selectedIndex}>
            {index === selectedIndex ? PICKER_SELECTED_MARKER : PICKER_UNSELECTED_MARKER}
          </Text>
          <Text color={index === selectedIndex ? C.assistant : C.muted} bold={index === selectedIndex} wrap="truncate-end">
            {cmd.usage.padEnd(Math.max(usageColumn, cmd.usage.length + 2) - 1)}
          </Text>
          <Text dimColor wrap="truncate-end">{cmd.description}</Text>
        </Box>
        );
      })}
      <Text dimColor wrap="truncate-end">Tab/Enter select  ↑↓ navigate  Esc close</Text>
    </Box>
  );
}

type SessionPaletteProps = {
  sessions: PersistedSessionMeta[];
  selectedIndex: number;
  command: "resume" | "sessions";
  loading: boolean;
  maxVisible?: number;
  width?: number;
};

export function SessionPalette({ sessions, selectedIndex, command, loading, maxVisible = 6, width }: SessionPaletteProps): React.ReactElement {
  const { visible, start } = visibleWindow(sessions, selectedIndex, maxVisible);
  return (
    <Box flexDirection="column" paddingX={2} width={width} minWidth={0} overflow="hidden">
      <Text dimColor wrap="truncate-end">── {command === "resume" ? "Resume sessions" : "Saved sessions"}</Text>
      {loading && <Text dimColor wrap="truncate-end">Loading saved sessions...</Text>}
      {!loading && sessions.length === 0 && <Text color={C.running} wrap="truncate-end">No saved sessions</Text>}
      {!loading && visible.map((session, index) => {
        const absoluteIndex = start + index;
        const preview = session.preview.replace(/\s+/g, " ").trim();
        return (
          <Box key={session.id} gap={1} minWidth={0}>
            <Text color={absoluteIndex === selectedIndex ? C.running : undefined} bold={absoluteIndex === selectedIndex}>
              {absoluteIndex === selectedIndex ? PICKER_SELECTED_MARKER : PICKER_UNSELECTED_MARKER}
            </Text>
            <Text color={absoluteIndex === selectedIndex ? C.assistant : C.muted} bold={absoluteIndex === selectedIndex} wrap="truncate-end">
              {session.id.slice(0, 12)}  {session.messageCount} msgs{preview ? `  ${preview}` : ""}
            </Text>
          </Box>
        );
      })}
      {!loading && sessions.length > visible.length && (
        <Text dimColor wrap="truncate-end">
          Showing {start + 1}-{start + visible.length} / {sessions.length}
        </Text>
      )}
      <Text dimColor wrap="truncate-end">
        {SESSION_PICKER_HINT}
      </Text>
    </Box>
  );
}

// ─── File autocomplete ────────────────────────────────────────────────────────

type FileAutocompleteProps = {
  candidates: string[];
  selectedIndex: number;
  prefix: string;
  maxVisible?: number;
  width?: number;
};

export function FileAutocomplete({ candidates, selectedIndex, prefix, maxVisible = 8, width }: FileAutocompleteProps): React.ReactElement | null {
  const { visible, start } = visibleWindow(candidates, selectedIndex, maxVisible);

  return (
    <Box flexDirection="column" paddingX={2} width={width} minWidth={0} overflow="hidden">
      <Text dimColor wrap="truncate-end">── Files {prefix}</Text>
      {candidates.length === 0 && <Text color={C.running} wrap="truncate-end">No matching files</Text>}
      {visible.map((candidate, i) => {
        const index = start + i;
        return (
        <Box key={candidate} gap={1} minWidth={0}>
          <Text color={index === selectedIndex ? C.running : undefined} bold={index === selectedIndex}>
            {index === selectedIndex ? PICKER_SELECTED_MARKER : PICKER_UNSELECTED_MARKER}
          </Text>
          <Text
            color={index === selectedIndex ? C.assistant : C.muted}
            bold={index === selectedIndex}
            wrap="truncate-end"
          >
            {candidate}
          </Text>
        </Box>
        );
      })}
      {candidates.length > visible.length && <Text dimColor wrap="truncate-end">Showing {start + 1}-{start + visible.length} / {candidates.length}</Text>}
      <Text dimColor wrap="truncate-end">Tab/→ complete  ↑↓ navigate  Esc close</Text>
    </Box>
  );
}

type ModelPickerProps = {
  candidates: string[];
  contextWindows: Record<string, number>;
  selectedIndex: number;
  query: string;
  current: string;
  maxVisible?: number;
  width?: number;
};

/**
 * Decimal context-window formatting shared with the status line.
 *
 * The previous local copy divided by 1024, so a 128000-token catalog entry was
 * advertised as `125K context` while the ANSI status row said `128k`.
 */
export function formatContextWindow(value: number): string {
  return formatContextWindowShared(value);
}

export function ModelPicker({ candidates, contextWindows, selectedIndex, query, current, maxVisible = 12, width }: ModelPickerProps): React.ReactElement | null {
  const pageSize = Math.max(1, maxVisible);
  const start = Math.max(0, Math.min(selectedIndex - pageSize + 1, candidates.length - pageSize));
  const visible = candidates.slice(start, start + pageSize);
  // Fixed name column so the context sizes line up (and match the ANSI picker).
  const nameColumn = Math.min(40, Math.max(0, ...visible.map((model) => model.length)) + 4);
  return (
    <Box flexDirection="column" paddingX={2} width={width} minWidth={0} overflow="hidden">
      <Text dimColor wrap="truncate-end">── Models {query || "all"}</Text>
      {visible.length === 0 && <Text color={C.running} wrap="truncate-end">No matching models</Text>}
      {visible.map((model, i) => {
        const index = start + i;
        const selected = index === selectedIndex;
        return (
          <Box key={model} gap={1} minWidth={0}>
            <Text color={selected ? C.running : undefined} bold={selected}>
              {selected ? PICKER_SELECTED_MARKER : PICKER_UNSELECTED_MARKER}
            </Text>
            <Text color={selected ? C.assistant : C.muted} bold={selected} wrap="truncate-end">
              {`${model === current ? "✓ " : "  "}${model}`.padEnd(Math.max(1, nameColumn - 1))}
            </Text>
            <Text dimColor wrap="truncate-end">{formatContextWindow(contextWindows[model] ?? 0)} context</Text>
          </Box>
        );
      })}
      {candidates.length > pageSize && (
        <Text dimColor wrap="truncate-end">Showing {start + 1}-{Math.min(start + pageSize, candidates.length)} / {candidates.length}</Text>
      )}
      <Text dimColor wrap="truncate-end">Enter select  ↑↓ navigate  Esc cancel</Text>
    </Box>
  );
}
