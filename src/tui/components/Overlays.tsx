import React from "react";
import { Box, Text } from "ink";
import { CommandPalette, FileAutocomplete, ModelPicker, SessionPalette } from "./FileAutocomplete.tsx";
import { TUI_COLORS as C } from "../theme.ts";
import { PICKER_SELECTED_MARKER, PICKER_UNSELECTED_MARKER } from "../claude-style.ts";
import {
  pickerHintText,
  pickerIsListMode,
  pickerRangeText,
  pickerTitleText,
  pickerVisibleWindow,
  profileRowText,
} from "../picker-window.ts";
import type { ModelSetupState, PendingProfileSetup, ProfileListState } from "../types.ts";
import type { CommandDef } from "./FileAutocomplete.tsx";
import type { AcMode } from "../input-utils.ts";
import { TodoEditor } from "./TodoEditor.tsx";
import type { TodoEditorState } from "../todo-editor.ts";
import type { PersistedSessionMeta } from "../../session-store.ts";
import type { ResumeMessageCandidate } from "../session-serialization.ts";

export type OverlaysProps = {
  acMode: AcMode;
  input: string;
  acIndex: number;
  cmdCandidates: CommandDef[];
  fileCandidates: string[];
  fileFragment: string;
  modelCandidates: string[];
  modelContextWindows: Record<string, number>;
  modelQuery: string;
  sessionCandidates: PersistedSessionMeta[];
  sessionCommand?: "resume" | "sessions";
  sessionLoading: boolean;
  resumeMessageCandidates?: ResumeMessageCandidate[];
  currentModel: string;
  modelSetup?: ModelSetupState;
  pendingProfileSetup?: PendingProfileSetup | null;
  profileListState?: ProfileListState | null;
  pickerItemRows: number;
  width?: number;
  todoEditorState?: TodoEditorState;
  onTodoCancel?: () => void;
  onTodoInput?: (value: string) => void;
  onTodoConfirm?: () => void;
};

export function Overlays({
  acMode,
  input,
  acIndex,
  cmdCandidates,
  fileCandidates,
  fileFragment,
  modelCandidates,
  modelContextWindows,
  modelQuery,
  sessionCandidates,
  sessionCommand,
  sessionLoading,
  resumeMessageCandidates = [],
  currentModel,
  modelSetup,
  pendingProfileSetup,
  profileListState,
  pickerItemRows,
  width,
  todoEditorState,
  onTodoCancel,
  onTodoInput,
  onTodoConfirm,
}: OverlaysProps): React.ReactElement | null {
  if (todoEditorState && onTodoCancel && onTodoInput && onTodoConfirm) {
    return <TodoEditor state={todoEditorState} onCancel={onTodoCancel} onStateChange={onTodoInput} onConfirm={onTodoConfirm} />;
  }
  if (!acMode) return null;
  // A very short terminal may have no spare picker rows. Keep the prompt and
  // status chrome visible instead of letting a zero-budget overlay push them
  // off the frame.
  if (pickerItemRows <= 0 && pickerIsListMode(acMode)) return null;

  if (acMode === "command") {
    return (
      <CommandPalette
        filter={input.slice(1)}
        selectedIndex={acIndex}
        candidates={cmdCandidates}
        maxVisible={pickerItemRows}
        width={width}
      />
    );
  }

  if (acMode === "resume-messages") {
    // Windowed like every other picker: an unbounded history list could push
    // the prompt past the last terminal row, which makes Ink clear the screen.
    const { visible, start } = pickerVisibleWindow(resumeMessageCandidates, acIndex, pickerItemRows);
    return (
      <Box flexDirection="column" paddingX={2} width={width} minWidth={0} overflow="hidden">
        <Text dimColor wrap="truncate-end">── {pickerTitleText("resume-messages")}</Text>
        {resumeMessageCandidates.length === 0 && <Text color={C.running}>No selectable messages</Text>}
        {visible.map((candidate, visibleIndex) => {
          const index = start + visibleIndex;
          return (
          <Box key={`${candidate.id ?? candidate.boundary}-${index}`} gap={1} minWidth={0}>
            <Text color={index === acIndex ? C.running : undefined} bold={index === acIndex}>{index === acIndex ? PICKER_SELECTED_MARKER : PICKER_UNSELECTED_MARKER}</Text>
            <Text color={index === acIndex ? C.assistant : C.muted} bold={index === acIndex} wrap="truncate-end">
              {candidate.role}  {candidate.text || "(tool call)"}
            </Text>
          </Box>
          );
        })}
        {resumeMessageCandidates.length > visible.length && (
          <Text dimColor wrap="truncate-end">{pickerRangeText(start, visible.length, resumeMessageCandidates.length)}</Text>
        )}
        <Text dimColor wrap="truncate-end">{pickerHintText("resume-messages")}</Text>
      </Box>
    );
  }

  if (acMode === "session-list" && sessionCommand) {
    return (
      <SessionPalette
        sessions={sessionCandidates}
        selectedIndex={acIndex}
        command={sessionCommand}
        loading={sessionLoading}
        maxVisible={pickerItemRows}
        width={width}
      />
    );
  }

  if (acMode === "file") {
    return (
      <FileAutocomplete
        candidates={fileCandidates}
        selectedIndex={acIndex}
        prefix={fileFragment}
        maxVisible={pickerItemRows}
        width={width}
      />
    );
  }

  if (acMode === "model" || acMode === "model-picker") {
    return (
      <ModelPicker
        candidates={modelCandidates}
        contextWindows={modelContextWindows}
        selectedIndex={acIndex}
        query={modelQuery}
        current={currentModel}
        maxVisible={pickerItemRows}
        width={width}
      />
    );
  }

  if (acMode === "model-setup" && modelSetup) {
    return (
      <Box flexDirection="column" paddingX={2} width={width} minWidth={0}>
        <Text color={C.primary} bold wrap="truncate-end">⚙ Configure model</Text>
        <Text wrap="truncate-end">Model: {modelSetup.model.provider}/{modelSetup.model.id}</Text>
        <Text dimColor wrap="truncate-end">Base URL: {modelSetup.field === "baseUrl" ? "editing" : modelSetup.baseUrl}</Text>
        <Text dimColor wrap="truncate-end">API key: {modelSetup.field === "apiKey" ? "editing" : "set"}</Text>
        {modelSetup.error && <Text color={C.error} wrap="truncate-end">{modelSetup.error}</Text>}
        <Text dimColor wrap="truncate-end">Enter confirm field  ·  Esc cancel</Text>
      </Box>
    );
  }

  if (acMode === "profile-name" && pendingProfileSetup) {
    return (
      <Box flexDirection="column" paddingX={2} width={width} minWidth={0}>
        <Text color={C.primary} bold wrap="truncate-end">▣ Save model profile</Text>
        <Text wrap="truncate-end">Model: {pendingProfileSetup.model.provider}/{pendingProfileSetup.model.id}</Text>
        <Text dimColor wrap="truncate-end">Type a profile name  ·  Enter save  ·  Esc skip</Text>
      </Box>
    );
  }

  if (acMode === "profile-list" && profileListState) {
    const { visible, start } = pickerVisibleWindow(profileListState.profiles, profileListState.selectedIndex, pickerItemRows);
    return (
      <Box flexDirection="column" paddingX={2} width={width} minWidth={0}>
        <Text color={C.primary} bold wrap="truncate-end">▣ Model profiles</Text>
        {profileListState.profiles.length === 0 && <Text dimColor wrap="truncate-end">No saved profiles</Text>}
        {visible.map((profile, visibleIndex) => {
          const index = start + visibleIndex;
          return (
            <Text key={profile.name} color={index === profileListState.selectedIndex ? C.assistant : C.muted} wrap="truncate-end">
              {profileRowText(profile, index === profileListState.selectedIndex)}
            </Text>
          );
        })}
        {profileListState.profiles.length > visible.length && (
          <Text dimColor wrap="truncate-end">{pickerRangeText(start, visible.length, profileListState.profiles.length)}</Text>
        )}
        <Text dimColor wrap="truncate-end">{pickerHintText("profile-list")}</Text>
      </Box>
    );
  }

  return null;
}
