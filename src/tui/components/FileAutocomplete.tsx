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
import {
  modelNameColumn,
  modelNameLabel,
  pickerHintText,
  pickerMaxVisibleItems,
  pickerRangeText,
  pickerTitleText,
  pickerVisibleWindow,
  sessionRowContent,
} from "../picker-window.ts";

type CommandPaletteProps = {
  filter: string;         // what the user typed after /
  selectedIndex: number;
  candidates: CommandDef[];
  maxVisible?: number;
  width?: number;
};

export function CommandPalette({ filter, selectedIndex, candidates, maxVisible = pickerMaxVisibleItems("command"), width }: CommandPaletteProps): React.ReactElement | null {
  const { visible, start } = pickerVisibleWindow(candidates, selectedIndex, maxVisible);
  // Same column the ANSI palette and `/help` use, so descriptions line up.
  const usageColumn = commandUsageColumn(candidates);

  return (
    <Box flexDirection="column" paddingX={2} width={width} minWidth={0} overflow="hidden">
      <Text dimColor wrap="truncate-end">── {pickerTitleText("command", { filter })}</Text>
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
      {candidates.length > visible.length && (
        <Text dimColor wrap="truncate-end">{pickerRangeText(start, visible.length, candidates.length)}</Text>
      )}
      <Text dimColor wrap="truncate-end">{pickerHintText("command")}</Text>
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

export function SessionPalette({ sessions, selectedIndex, command, loading, maxVisible = pickerMaxVisibleItems("session-list"), width }: SessionPaletteProps): React.ReactElement {
  const { visible, start } = pickerVisibleWindow(sessions, selectedIndex, maxVisible);
  return (
    <Box flexDirection="column" paddingX={2} width={width} minWidth={0} overflow="hidden">
      <Text dimColor wrap="truncate-end">── {command === "resume" ? "Resume sessions" : "Saved sessions"}</Text>
      {loading && <Text dimColor wrap="truncate-end">Loading saved sessions…</Text>}
      {!loading && sessions.length === 0 && <Text color={C.running} wrap="truncate-end">No saved sessions</Text>}
      {!loading && visible.map((session, index) => {
        const absoluteIndex = start + index;
        return (
          <Box key={session.id} gap={1} minWidth={0}>
            <Text color={absoluteIndex === selectedIndex ? C.running : undefined} bold={absoluteIndex === selectedIndex}>
              {absoluteIndex === selectedIndex ? PICKER_SELECTED_MARKER : PICKER_UNSELECTED_MARKER}
            </Text>
            <Text color={absoluteIndex === selectedIndex ? C.assistant : C.muted} bold={absoluteIndex === selectedIndex} wrap="truncate-end">
              {sessionRowContent(session)}
            </Text>
          </Box>
        );
      })}
      {!loading && sessions.length > visible.length && (
        <Text dimColor wrap="truncate-end">
          {pickerRangeText(start, visible.length, sessions.length)}
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

export function FileAutocomplete({ candidates, selectedIndex, prefix, maxVisible = pickerMaxVisibleItems("file"), width }: FileAutocompleteProps): React.ReactElement | null {
  const { visible, start } = pickerVisibleWindow(candidates, selectedIndex, maxVisible);

  return (
    <Box flexDirection="column" paddingX={2} width={width} minWidth={0} overflow="hidden">
      <Text dimColor wrap="truncate-end">── {pickerTitleText("file", { fragment: prefix })}</Text>
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
      {candidates.length > visible.length && <Text dimColor wrap="truncate-end">{pickerRangeText(start, visible.length, candidates.length)}</Text>}
      <Text dimColor wrap="truncate-end">{pickerHintText("file")}</Text>
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

export function ModelPicker({ candidates, contextWindows, selectedIndex, query, current, maxVisible = pickerMaxVisibleItems("model"), width }: ModelPickerProps): React.ReactElement | null {
  const { visible, start } = pickerVisibleWindow(candidates, selectedIndex, maxVisible);
  // Fixed name column so the context sizes line up (and match the ANSI picker).
  const nameColumn = modelNameColumn(visible);
  return (
    <Box flexDirection="column" paddingX={2} width={width} minWidth={0} overflow="hidden">
      <Text dimColor wrap="truncate-end">── {pickerTitleText("model", { query })}</Text>
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
              {modelNameLabel(model, model === current).padEnd(Math.max(1, Math.max(nameColumn, model.length + 4) - 1))}
            </Text>
            <Text dimColor wrap="truncate-end">{formatContextWindow(contextWindows[model] ?? 0)} context</Text>
          </Box>
        );
      })}
      {candidates.length > visible.length && (
        <Text dimColor wrap="truncate-end">{pickerRangeText(start, visible.length, candidates.length)}</Text>
      )}
      <Text dimColor wrap="truncate-end">{pickerHintText("model")}</Text>
    </Box>
  );
}
