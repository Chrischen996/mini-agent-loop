import { useState, useCallback, useRef, useEffect } from "react";
import { SLASH_COMMANDS, type CommandDef } from "../components/FileAutocomplete.tsx";
import { PATH_COMMANDS } from "../slash-commands.ts";
import { listCandidates } from "../file-completion.ts";
import { modelChoices, modelSearchQuery, parseModelCommand } from "../model-command.ts";
import { extractFileAcTrigger, type AcMode, type FileAcTrigger } from "../input-utils.ts";
import type { ModelSetupState, ProfileListState } from "../types.ts";

export type UseAutocompleteOptions = {
  input: string;
  cwd: string;
  setInput: (value: string) => void;
  resetInputCursorToEnd: () => void;
  setPendingProfileSetup: (value: { model: { provider: string; id: string }; baseUrl: string; apiKey: string } | null) => void;
  setProfileListState: (value: ProfileListState | null) => void;
};

export function useAutocomplete({
  input,
  cwd,
  setInput,
  resetInputCursorToEnd,
  setPendingProfileSetup,
  setProfileListState,
}: UseAutocompleteOptions) {
  const [acMode, setAcMode] = useState<AcMode>(null);
  const [acIndex, setAcIndex] = useState(0);
  const [cmdCandidates, setCmdCandidates] = useState<CommandDef[]>([]);
  const [fileCandidates, setFileCandidates] = useState<string[]>([]);
  const [modelCandidates, setModelCandidates] = useState<string[]>([]);
  const [modelContextWindows, setModelContextWindows] = useState<Record<string, number>>({});
  const [modelQuery, setModelQuery] = useState("");
  const [modelSetup, setModelSetup] = useState<ModelSetupState | undefined>();
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
  }, [setPendingProfileSetup, setProfileListState]);

  useEffect(() => {
    if (acDebounceRef.current) clearTimeout(acDebounceRef.current);

    if (acMode === "model-picker") {
      const query = modelSearchQuery(input);
      const choices = modelChoices(query);
      setModelQuery(query);
      setModelCandidates(choices.references);
      setModelContextWindows(choices.contextWindows);
      setAcIndex((index) => Math.min(index, Math.max(0, choices.references.length - 1)));
      return;
    }

    if (acMode === "model-setup") return;

    if (/^\/[^/\s]*$/.test(input)) {
      const typed = input.slice(1).toLowerCase();
      const matches = SLASH_COMMANDS.filter((c) => c.name.startsWith(typed));
      setCmdCandidates(matches);
      setFileCandidates([]);
      setAcMode(matches.length > 0 ? "command" : null);
      setAcIndex(0);
      return;
    }

    const modelTrigger = input.match(/^\/model(?:\s+(.*))?$/i);
    if (modelTrigger) {
      const query = parseModelCommand(modelTrigger[1] ?? "").reference;
      const choices = modelChoices(query);
      setModelQuery(query);
      setModelCandidates(choices.references);
      setModelContextWindows(choices.contextWindows);
      setCmdCandidates([]);
      setFileCandidates([]);
      setAcMode("model");
      setAcIndex(0);
      return;
    }

    const fileTrigger = extractFileAcTrigger(input);
    if (fileTrigger) {
      fileTriggerRef.current = fileTrigger;
      setFileFragment(fileTrigger.fragment);
      setCmdCandidates([]);
      acDebounceRef.current = setTimeout(async () => {
        const candidates = await listCandidates(cwd, fileTrigger.fragment);
        setFileCandidates(candidates);
        setAcMode(candidates.length > 0 ? "file" : null);
        setAcIndex(0);
      }, 150);
      return;
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
      if (PATH_COMMANDS.has(cmd.name)) {
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

  const handleTabAt = useCallback(
    (inputVal: string) => {
      if (acMode === "file" || acMode === "command" || acMode === "model" || acMode === "model-picker") {
        return;
      }
      const trigger = extractFileAcTrigger(inputVal);
      if (!trigger) return;
      fileTriggerRef.current = trigger;
      setFileFragment(trigger.fragment);
      setCmdCandidates([]);
      setAcMode("file");
      if (acDebounceRef.current) clearTimeout(acDebounceRef.current);
      acDebounceRef.current = setTimeout(async () => {
        const candidates = await listCandidates(cwd, trigger.fragment);
        setFileCandidates(candidates);
      }, 0);
    },
    [acMode, cwd],
  );

  const openModelPicker = useCallback(
    (query = "") => {
      const choices = modelChoices(query);
      setModelQuery(query);
      setModelCandidates(choices.references);
      setModelContextWindows(choices.contextWindows);
      setAcIndex(0);
      setInput(query);
      setAcMode("model-picker");
    },
    [setInput],
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
    fileFragment,
    clearAc,
    acceptCommand,
    acceptFile,
    handleTabAt,
    openModelPicker,
  };
}
