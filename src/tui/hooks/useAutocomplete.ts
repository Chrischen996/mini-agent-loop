import { useState, useCallback, useRef, useEffect } from "react";
import { type CommandDef } from "../components/FileAutocomplete.tsx";
import { ARGUMENT_COMMANDS, PATH_COMMANDS } from "../slash-commands.ts";
import { listCandidates } from "../file-completion.ts";
import { modelChoices } from "../model-command.ts";
import { type AcMode, type FileAcTrigger } from "../input-utils.ts";
import type { ModelRef } from "../../models.ts";
import type { ModelSetupState, PendingProfileSetup, ProfileListState } from "../types.ts";
import {
  currentAutocompleteNavIndex,
  isOverlayAcMode,
  resolveAutocompleteInput,
  resolveAutocompleteNav,
  type AutocompleteNavKey,
} from "../autocomplete.ts";

export type UseAutocompleteOptions = {
  input: string;
  cwd: string;
  setInput: (value: string) => void;
  resetInputCursorToEnd: () => void;
};

export function useAutocomplete({
  input,
  cwd,
  setInput,
  resetInputCursorToEnd,
}: UseAutocompleteOptions) {
  const [acMode, setAcMode] = useState<AcMode>(null);
  const [acIndex, setAcIndex] = useState(0);
  const [cmdCandidates, setCmdCandidates] = useState<CommandDef[]>([]);
  const [fileCandidates, setFileCandidates] = useState<string[]>([]);
  const [modelCandidates, setModelCandidates] = useState<string[]>([]);
  const [modelContextWindows, setModelContextWindows] = useState<Record<string, number>>({});
  const [modelQuery, setModelQuery] = useState("");
  const [modelSetup, setModelSetup] = useState<ModelSetupState | undefined>();
  const [pendingProfileSetup, setPendingProfileSetup] = useState<PendingProfileSetup | null>(null);
  const [profileListState, setProfileListState] = useState<ProfileListState | null>(null);
  const [fileFragment, setFileFragment] = useState("");
  const fileTriggerRef = useRef<FileAcTrigger | null>(null);
  const acDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAc = useCallback(() => {
    setAcMode(null);
    setCmdCandidates([]);
    setFileCandidates([]);
    setModelCandidates([]);
    setModelContextWindows({});
    setModelQuery("");
    setModelSetup(undefined);
    setFileFragment("");
    fileTriggerRef.current = null;
    setAcIndex(0);
    setPendingProfileSetup(null);
    setProfileListState(null);
  }, []);

  useEffect(() => {
    if (acDebounceRef.current) clearTimeout(acDebounceRef.current);

    const resolution = resolveAutocompleteInput(input, acMode);

    if (resolution.kind === "model-picker") {
      const choices = modelChoices(resolution.query);
      setModelQuery(resolution.query);
      setModelCandidates(choices.references);
      setModelContextWindows(choices.contextWindows);
      setAcIndex((index) => Math.min(index, Math.max(0, choices.references.length - 1)));
      return;
    }

    if (resolution.kind === "sticky") return;

    if (resolution.kind === "command") {
      setCmdCandidates(resolution.candidates);
      setFileCandidates([]);
      setAcMode(resolution.candidates.length > 0 ? "command" : null);
      setAcIndex(0);
      return;
    }

    if (resolution.kind === "model") {
      const choices = modelChoices(resolution.query);
      setModelQuery(resolution.query);
      setModelCandidates(choices.references);
      setModelContextWindows(choices.contextWindows);
      setCmdCandidates([]);
      setFileCandidates([]);
      setAcMode("model");
      setAcIndex(0);
      return;
    }

    if (resolution.kind === "file") {
      fileTriggerRef.current = resolution.trigger;
      setFileFragment(resolution.trigger.fragment);
      setCmdCandidates([]);
      acDebounceRef.current = setTimeout(async () => {
        const candidates = await listCandidates(cwd, resolution.trigger.fragment);
        setFileCandidates(candidates);
        setAcMode(candidates.length > 0 ? "file" : null);
        setAcIndex(0);
      }, 150);
      return () => {
        if (acDebounceRef.current) clearTimeout(acDebounceRef.current);
      };
    }

    clearAc();

    return () => {
      if (acDebounceRef.current) clearTimeout(acDebounceRef.current);
    };
  }, [input, cwd, clearAc, acMode]);

  const acceptCommand = useCallback(
    (idx: number) => {
      const cmd = cmdCandidates[idx];
      if (!cmd) return;
      if (PATH_COMMANDS.has(cmd.name) || ARGUMENT_COMMANDS.has(cmd.name)) {
        setInput(`/${cmd.name} `);
      } else {
        setInput(`/${cmd.name}`);
        clearAc();
      }
      resetInputCursorToEnd();
      setAcMode(null);
      setCmdCandidates([]);
      setAcIndex(0);
    },
    [cmdCandidates, clearAc, resetInputCursorToEnd, setInput],
  );

  const acceptFile = useCallback(
    (idx: number) => {
      const trigger = fileTriggerRef.current;
      const chosen = fileCandidates[idx];
      if (!trigger || !chosen) return;
      setInput(trigger.replaceFn(chosen));
      resetInputCursorToEnd();
      clearAc();
    },
    [fileCandidates, clearAc, resetInputCursorToEnd, setInput],
  );

  const acceptModel = useCallback(
    (idx: number) => {
      const chosen = modelCandidates[idx];
      if (!chosen) return false;
      setInput(`/model ${chosen}`);
      resetInputCursorToEnd();
      clearAc();
      return true;
    },
    [modelCandidates, clearAc, resetInputCursorToEnd, setInput],
  );

  const handleTabAt = useCallback(
    (inputVal: string) => {
      // App.useInput already owns Tab while a picker/overlay is open.
      if (isOverlayAcMode(acMode)) return;
      const resolution = resolveAutocompleteInput(inputVal, null);
      if (resolution.kind !== "file") return;
      fileTriggerRef.current = resolution.trigger;
      setFileFragment(resolution.trigger.fragment);
      setCmdCandidates([]);
      setAcMode("file");
      if (acDebounceRef.current) clearTimeout(acDebounceRef.current);
      acDebounceRef.current = setTimeout(async () => {
        const candidates = await listCandidates(cwd, resolution.trigger.fragment);
        setFileCandidates(candidates);
      }, 0);
    },
    [acMode, cwd],
  );

  const openModelPicker = useCallback(
    (query = "", models?: ModelRef[]) => {
      const choices = modelChoices(query, models);
      setModelQuery(query);
      setModelCandidates(choices.references);
      setModelContextWindows(choices.contextWindows);
      setAcIndex(0);
      setInput(query);
      setAcMode("model-picker");
    },
    [setInput],
  );

  const handleAutocompleteKey = useCallback(
    (key: AutocompleteNavKey): boolean => {
      const navIndex = currentAutocompleteNavIndex(
        acMode,
        acIndex,
        profileListState?.selectedIndex ?? 0,
      );
      const action = resolveAutocompleteNav(acMode, key, navIndex, {
        commands: cmdCandidates.length,
        files: fileCandidates.length,
        models: modelCandidates.length,
        profiles: profileListState?.profiles.length ?? 0,
      });

      switch (action.type) {
        case "none":
          return false;
        case "ignore":
          return true;
        case "move":
          if (acMode === "profile-list") {
            setProfileListState((state) =>
              state ? { ...state, selectedIndex: action.index } : state,
            );
          } else {
            setAcIndex(action.index);
          }
          return true;
        case "accept-command":
          acceptCommand(acIndex);
          return true;
        case "accept-file":
          acceptFile(acIndex);
          return true;
        case "accept-model":
          acceptModel(acIndex);
          return true;
        case "cancel":
          if (action.clearInput) setInput("");
          clearAc();
          return true;
      }
    },
    [
      acMode,
      acIndex,
      cmdCandidates.length,
      fileCandidates.length,
      modelCandidates.length,
      profileListState,
      acceptCommand,
      acceptFile,
      acceptModel,
      clearAc,
      setInput,
    ],
  );

  return {
    acMode,
    setAcMode,
    acIndex,
    setAcIndex,
    cmdCandidates,
    fileCandidates,
    modelCandidates,
    modelContextWindows,
    modelQuery,
    modelSetup,
    setModelSetup,
    pendingProfileSetup,
    setPendingProfileSetup,
    profileListState,
    setProfileListState,
    fileFragment,
    clearAc,
    acceptCommand,
    acceptFile,
    acceptModel,
    handleTabAt,
    handleAutocompleteKey,
    openModelPicker,
  };
}
