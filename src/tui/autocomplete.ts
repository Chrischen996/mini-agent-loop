import { SLASH_COMMANDS, type CommandDef } from "./components/FileAutocomplete.tsx";
import { extractFileAcTrigger, type AcMode, type FileAcTrigger } from "./input-utils.ts";
import { modelSearchQuery, parseModelCommand } from "./model-command.ts";

export const STICKY_AC_MODES = new Set<AcMode>(["model-setup", "profile-name", "profile-list"]);
export const PICKER_AC_MODES = new Set<AcMode>(["file", "command", "model", "model-picker"]);

export function isStickyAcMode(mode: AcMode): boolean {
  return STICKY_AC_MODES.has(mode);
}

export function isPickerAcMode(mode: AcMode): boolean {
  return PICKER_AC_MODES.has(mode);
}

export function isOverlayAcMode(mode: AcMode): boolean {
  return isStickyAcMode(mode) || isPickerAcMode(mode);
}

/** Profile list keeps its own selectedIndex; other overlays share acIndex. */
export function currentAutocompleteNavIndex(
  acMode: AcMode,
  acIndex: number,
  profileSelectedIndex = 0,
): number {
  return acMode === "profile-list" ? profileSelectedIndex : acIndex;
}

/** Wrap around a list; empty lists stay at 0. */
export function nextWrappedIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (index + delta % length + length) % length;
}

/** Clamp to `[0, length-1]`; empty lists stay at 0. */
export function nextClampedIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, index + delta));
}

/** `/cmd` with no space yet — the command palette trigger. */
export function isCommandPaletteInput(input: string): boolean {
  return /^\/[^/\s]*$/.test(input);
}

export function matchSlashCommands(
  input: string,
  commands: readonly CommandDef[] = SLASH_COMMANDS,
): CommandDef[] {
  const typed = (input.startsWith("/") ? input.slice(1) : input).toLowerCase();
  return commands.filter((command) => command.name.startsWith(typed));
}

/**
 * Query for an inline `/model …` line.
 * Returns `null` when the input is not a model command (bare `/model` is
 * handled by the command palette instead).
 */
export function extractInlineModelQuery(input: string): string | null {
  const modelTrigger = input.match(/^\/model(?:\s+(.*))$/i);
  if (!modelTrigger) return null;
  return parseModelCommand(modelTrigger[1] ?? "").reference;
}

export type AutocompleteResolution =
  | { kind: "sticky" }
  | { kind: "model-picker"; query: string }
  | { kind: "command"; candidates: CommandDef[] }
  | { kind: "model"; query: string }
  | { kind: "file"; trigger: FileAcTrigger }
  | { kind: "none" };

/**
 * Decide which autocomplete overlay the current input should drive.
 * Sticky overlays (model-setup / profile-*) own the field and ignore triggers.
 */
export function resolveAutocompleteInput(
  input: string,
  acMode: AcMode,
  commands: readonly CommandDef[] = SLASH_COMMANDS,
): AutocompleteResolution {
  if (acMode === "model-picker") {
    return { kind: "model-picker", query: modelSearchQuery(input) };
  }
  if (isStickyAcMode(acMode)) return { kind: "sticky" };

  if (isCommandPaletteInput(input)) {
    return { kind: "command", candidates: matchSlashCommands(input, commands) };
  }

  const modelQuery = extractInlineModelQuery(input);
  if (modelQuery !== null) {
    return { kind: "model", query: modelQuery };
  }

  const trigger = extractFileAcTrigger(input);
  if (trigger) return { kind: "file", trigger };

  return { kind: "none" };
}

export type AutocompleteNavKey = {
  upArrow?: boolean;
  downArrow?: boolean;
  tab?: boolean;
  rightArrow?: boolean;
  escape?: boolean;
};

export type AutocompleteNavAction =
  | { type: "none" }
  | { type: "ignore" }
  | { type: "move"; index: number }
  | { type: "accept-command" }
  | { type: "accept-file" }
  | { type: "accept-model" }
  | { type: "cancel"; clearInput?: boolean };

/**
 * Pure keyboard mapping for autocomplete overlays.
 * `ignore` means the overlay owns the key (do not fall through to App shortcuts).
 */
export function resolveAutocompleteNav(
  acMode: AcMode,
  key: AutocompleteNavKey,
  acIndex: number,
  lengths: { commands: number; files: number; models: number; profiles: number },
): AutocompleteNavAction {
  if (acMode === "profile-name" || acMode === "model-setup") {
    if (key.escape) return { type: "cancel", clearInput: true };
    return { type: "ignore" };
  }

  if (acMode === "profile-list") {
    if (key.upArrow) return { type: "move", index: nextWrappedIndex(acIndex, -1, lengths.profiles) };
    if (key.downArrow) return { type: "move", index: nextWrappedIndex(acIndex, 1, lengths.profiles) };
    if (key.escape) return { type: "cancel", clearInput: true };
    return { type: "ignore" };
  }

  if (acMode === "command") {
    if (key.upArrow) return { type: "move", index: nextWrappedIndex(acIndex, -1, lengths.commands) };
    if (key.downArrow) return { type: "move", index: nextWrappedIndex(acIndex, 1, lengths.commands) };
    if (key.tab) return { type: "accept-command" };
    if (key.escape) return { type: "cancel" };
    return { type: "ignore" };
  }

  if (acMode === "file") {
    if (key.upArrow) return { type: "move", index: nextClampedIndex(acIndex, -1, lengths.files) };
    if (key.downArrow) return { type: "move", index: nextClampedIndex(acIndex, 1, lengths.files) };
    if (key.tab || key.rightArrow) return { type: "accept-file" };
    if (key.escape) return { type: "cancel" };
    return { type: "none" };
  }

  if (acMode === "model" || acMode === "model-picker") {
    if (key.upArrow) return { type: "move", index: nextWrappedIndex(acIndex, -1, lengths.models) };
    if (key.downArrow) return { type: "move", index: nextWrappedIndex(acIndex, 1, lengths.models) };
    if (key.tab) return { type: "accept-model" };
    if (key.escape) return { type: "cancel", clearInput: true };
    return { type: "none" };
  }

  return { type: "none" };
}
