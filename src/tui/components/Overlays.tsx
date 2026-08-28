import React from "react";
import { Box, Text } from "ink";
import { CommandPalette, FileAutocomplete, ModelPicker } from "./FileAutocomplete.tsx";
import { TUI_COLORS as C } from "../theme.ts";
import type { ModelSetupState, PendingProfileSetup, ProfileListState } from "../types.ts";
import type { CommandDef } from "./FileAutocomplete.tsx";
import type { AcMode } from "../input-utils.ts";

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
  currentModel: string;
  modelSetup?: ModelSetupState;
  pendingProfileSetup?: PendingProfileSetup | null;
  profileListState?: ProfileListState | null;
  pickerItemRows: number;
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
  currentModel,
  modelSetup,
  pendingProfileSetup,
  profileListState,
  pickerItemRows,
}: OverlaysProps): React.ReactElement | null {
  if (!acMode) return null;

  if (acMode === "command") {
    return (
      <CommandPalette
        filter={input.slice(1)}
        selectedIndex={acIndex}
        candidates={cmdCandidates}
        maxVisible={pickerItemRows}
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
      />
    );
  }

  if (acMode === "model-setup" && modelSetup) {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text color={C.primary} bold>── Configure model ──</Text>
        <Text>Model: {modelSetup.model.provider}/{modelSetup.model.id}</Text>
        <Text dimColor>Base URL: {modelSetup.field === "baseUrl" ? "editing" : modelSetup.baseUrl}</Text>
        <Text dimColor>API key: {modelSetup.field === "apiKey" ? "editing" : "set"}</Text>
        {modelSetup.error && <Text color={C.error}>{modelSetup.error}</Text>}
        <Text dimColor>Enter confirm field, Esc cancel</Text>
      </Box>
    );
  }

  if (acMode === "profile-name" && pendingProfileSetup) {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text color={C.primary} bold>── Save model profile ──</Text>
        <Text>Model: {pendingProfileSetup.model.provider}/{pendingProfileSetup.model.id}</Text>
        <Text dimColor>Type a profile name (Enter save, Esc skip):</Text>
      </Box>
    );
  }

  if (acMode === "profile-list" && profileListState) {
    const count = Math.max(1, pickerItemRows);
    const start = Math.max(0, Math.min(
      profileListState.selectedIndex - count + 1,
      profileListState.profiles.length - count,
    ));
    const visible = profileListState.profiles.slice(start, start + count);
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text color={C.primary} bold>── Model profiles ──</Text>
        {profileListState.profiles.length === 0 && <Text dimColor>No saved profiles</Text>}
        {visible.map((profile, visibleIndex) => {
          const index = start + visibleIndex;
          return (
            <Text key={profile.name} color={index === profileListState.selectedIndex ? C.selection : undefined}>
              {index === profileListState.selectedIndex ? "▶ " : "  "}
              {profile.active ? "✓ " : "  "}
              {profile.name} ({profile.model}) — {profile.baseUrl}
            </Text>
          );
        })}
        {profileListState.profiles.length > visible.length && (
          <Text dimColor>Showing {start + 1}-{start + visible.length} / {profileListState.profiles.length}</Text>
        )}
        <Text dimColor>↑↓ select, Enter activate, Esc cancel, /profiles delete &lt;name&gt;</Text>
      </Box>
    );
  }

  return null;
}
