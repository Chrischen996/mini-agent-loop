import React, { useReducer, useState, useCallback, useRef, useEffect, useMemo, useLayoutEffect } from "react";
import { randomUUID } from "node:crypto";
import { Box, Text, useApp, useInput, useStdout, type Key } from "ink";
import { readdir, stat } from "node:fs/promises";
import * as nodePath from "node:path";
import { MessageFeed } from "./components/MessageFeed.tsx";
import { Header } from "./components/Header.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { PhaseIndicator } from "./components/PhaseIndicator.tsx";
import { PlanView } from "./components/PlanView.tsx";
import { resolvePendingPermissionDecision } from "./pending-permission.ts";
import {
  FileAutocomplete,
  CommandPalette,
  ModelPicker,
  SLASH_COMMANDS,
  type CommandDef,
} from "./components/FileAutocomplete.tsx";
import { tuiReducer, createInitialState } from "./state.ts";
import {
  createAgentHistory,
  MaxTurnsExceededError,
  runAgentTurn,
  type AgentRuntimeRef,
  type LoopEvent,
} from "../loop.ts";
import { LlmTimeoutError } from "../llm/retry.ts";
import { loadLlmConfigFromEnv, switchLlmModel, type LlmConfig, type ModelSwitchOverrides } from "../llm/index.ts";
import {
  buildIntenseLlm,
  cycleThinkingLevel,
  parseThinkingCommandMode,
  parseThinkingIntensityPrompt,
  thinkingLevelToDisplay,
  withThinkingLevel,
} from "../think-intensity.ts";
import { loadThinkingModeFromEnv } from "../thinking-policy.ts";
import { adaptHistoryForModel } from "../message-adapter.ts";
import { findExactModelReferenceMatch, getAllModels, resolveModel, searchModels, type ModelRef } from "../models.ts";
import {
  activateProfile,
  listProfiles,
  loadProfileStore,
  removeProfile,
  saveProfile,
  type ModelProfileStore,
} from "../profile-store.ts";
import {
  createVisionPreprocessor,
  loadVisionConfigFromEnv,
} from "../preprocessors/index.ts";
import { createAllTools, createTools } from "../tools/index.ts";
import { resolveToolProvider, type Tool, type ToolProvider } from "../tools/types.ts";
import type { AgentMessage, MessageContent } from "../types.ts";
import type { ImageAttachment } from "./state.ts";
import type { ChatMessage } from "./state.ts";
import {
  createSubagentTool,
  createSubagentBatchTool,
  defaultProfiles,
  loadAutoSubagentOptionsFromEnv,
} from "../subagent/index.ts";
import type { SubagentEvent } from "../subagent/types.ts";
import {
  PERMISSION_MODES,
  PermissionManager,
  PermissionModeChangedError,
  type PermissionDecision,
  type PermissionMode,
  type PermissionTurnContext,
} from "../permissions.ts";
import { TurnEventBuffer } from "./stream-buffer.ts";
import { getTuiViewportHeight, getMessageFeedHeight, getPickerLayout } from "./layout.ts";
import { estimateViewportContentHeight } from "./message-viewport.ts";

import { TUI_COLORS as C } from "./theme.ts";
import { PromptInput } from "./components/PromptInput.tsx";
import {
  extractFileAcTrigger,
  parseAtRefs,
  sanitizeInput,
  type FileAcTrigger,
  shouldAcceptAutocompleteOnEnter,
  type AcMode,
} from "./input-utils.ts";
import {
  imageAttachmentToPart,
  loadImageAttachment,
  MAX_TUI_IMAGES,
  readClipboardImage,
} from "./image-attachments.ts";
import {
  PLAN_ONLY_SUFFIX,
  approveCurrentPlan,
  archiveCurrentPlan,
  createAndSavePlan,
  formatPlanDocumentPreview,
  listPlanHistory,
  loadPlanDocument,
  markPlanExecutionResult,
  preparePlanForExecution,
  rejectCurrentPlan,
} from "../plan/index.ts";
import {
  applySkillCommand,
  defaultSkillRegistry,
  discoverWorkspaceSkills,
  loadSkillNamesFromEnv,
} from "../skills/index.ts";

type AppProps = { cwd: string; agentTools?: ToolProvider; allTools?: ToolProvider };
const DEFAULT_IMAGE_PROMPT = "请分析附件中的图片";

function modelChoices(query = "", models = getAllModels()): {
  references: string[];
  contextWindows: Record<string, number>;
} {
  const filtered = query.trim() ? searchModels(query, models) : models;
  return {
    references: filtered.map((model) => `${model.provider}/${model.id}`),
    contextWindows: Object.fromEntries(
      filtered.map((model) => [`${model.provider}/${model.id}`, model.contextWindow]),
    ),
  };
}

// ─── slash command parser ────────────────────────────────────────────────────

type SlashCommand =
  | { cmd: "read"; path: string }
  | { cmd: "bash"; command: string }
  | { cmd: "ls"; path: string }
  | { cmd: "find"; pattern: string; path: string }
  | { cmd: "grep"; pattern: string; path: string }
  | null;

type ModelCommand = {
  reference: string;
  overrides: ModelSwitchOverrides;
};

function parseModelCommand(raw: string): ModelCommand {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const referenceParts: string[] = [];
  const overrides: ModelSwitchOverrides = {};
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--base-url") {
      overrides.baseUrl = tokens[++index];
    } else if (token === "--api-key") {
      overrides.apiKey = tokens[++index];
    } else if (token === "--api-key-env") {
      const envName = tokens[++index];
      if (envName) overrides.apiKey = process.env[envName];
    } else {
      referenceParts.push(token);
    }
  }
  return { reference: referenceParts.join(" "), overrides };
}

function parseSlashCommand(input: string): SlashCommand {
  const s = input.trim();
  if (!s.startsWith("/")) return null;
  const parts = s.slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  switch (cmd) {
    case "read": { const path = parts.slice(1).join(" "); return path ? { cmd: "read", path } : null; }
    case "bash": case "sh": { const command = parts.slice(1).join(" "); return command ? { cmd: "bash", command } : null; }
    case "ls": return { cmd: "ls", path: parts[1] ?? "." };
    case "find": return { cmd: "find", pattern: parts[1] ?? "*", path: parts[2] ?? "." };
    case "grep": { const pattern = parts[1] ?? ""; const path = parts[2] ?? "."; return pattern ? { cmd: "grep", pattern, path } : null; }
    default: return null;
  }
}

// Commands that accept a path argument (trigger file autocomplete after selection)
const PATH_COMMANDS = new Set(["read", "ls", "find", "grep"]);

// ─── autocomplete modes ──────────────────────────────────────────────────────

type ModelSetupState = {
  model: ModelRef;
  baseUrl: string;
  apiKey: string;
  field: "baseUrl" | "apiKey";
  error?: string;
};

type ProfileListState = {
  profiles: ReturnType<typeof listProfiles>;
  selectedIndex: number;
};

// ─── file listing ────────────────────────────────────────────────────────────

async function listCandidates(cwd: string, fragment: string): Promise<string[]> {
  try {
    const lastSlash = fragment.lastIndexOf("/");
    const dir = lastSlash >= 0 ? fragment.slice(0, lastSlash + 1) : "";
    const prefix = lastSlash >= 0 ? fragment.slice(lastSlash + 1) : fragment;
    const absDir = nodePath.join(cwd, dir || ".");
    let entries: string[];
    try { entries = await readdir(absDir); } catch { return []; }
    const candidates: string[] = [];
    for (const entry of entries) {
      if (!entry.toLowerCase().startsWith(prefix.toLowerCase())) continue;
      if (entry.startsWith(".") && !prefix.startsWith(".")) continue;
      const rel = dir + entry;
      try {
        const info = await stat(nodePath.join(cwd, rel));
        candidates.push(info.isDirectory() ? `${rel}/` : rel);
      } catch { candidates.push(rel); }
    }
    return candidates.slice(0, 20);
  } catch { return []; }
}

// ─── main app ────────────────────────────────────────────────────────────────

export function App({ cwd, agentTools, allTools }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  // Leave one terminal row unused so Ink never enters its full-screen clear
  // path (`outputHeight >= rows`) while streamed reasoning is growing.
  const termHeight = getTuiViewportHeight(stdout?.rows);
  const [llm, setLlm] = useState<LlmConfig>(() => loadLlmConfigFromEnv());
  const llmRef = useRef(llm);
  llmRef.current = llm;
  const vision = loadVisionConfigFromEnv();
  const autoSubagent = useMemo(() => loadAutoSubagentOptionsFromEnv(), []);
  const [skillNames, setSkillNames] = useState<string[]>(() => loadSkillNamesFromEnv());
  const skillNamesRef = useRef(skillNames);
  skillNamesRef.current = skillNames;
  const allToolsRef = useRef<ToolProvider>(allTools ?? createAllTools(cwd));
  const agentToolsRef = useRef<ToolProvider>(agentTools ?? createTools(cwd, { codebase: process.env.EXTERNAL_CODEBASE_ENABLED !== "0" }));

  // Create the subagent tool — dispatches SubagentEvents to the TUI reducer
  const subagentToolsRef = useRef<Tool[]>([]);
  const subagentRuntimeRef = useRef<AgentRuntimeRef>({});
  const getSubagentTools = useCallback((parentLlm = llm): Tool[] => {
    if (subagentToolsRef.current.length === 0) {
      const sharedOptions = {
        parentLlm,
        parentTools: agentToolsRef.current,
        profiles: defaultProfiles,
        preprocessors: vision ? [createVisionPreprocessor(vision)] : [],
        onSubagentEvent: (event: SubagentEvent) => {
          dispatch({ type: "SUBAGENT_EVENT", event });
        },
        getPermissionTurn: () => permissionTurnRef.current ?? undefined,
        parentRuntime: subagentRuntimeRef.current,
      };
      subagentToolsRef.current = [
        createSubagentTool(sharedOptions) as Tool,
        createSubagentBatchTool(sharedOptions) as Tool,
      ];
    }
    return subagentToolsRef.current;
  }, [llm, vision]);

  const [state, dispatch] = useReducer(tuiReducer, createInitialState(llm.model));
  // Generate a stable conversation session ID on startup
  const [conversationId, setConversationId] = useState(() => process.env.MINI_AGENT_SESSION_ID ?? randomUUID());
  
  // Plan-Act approval callbacks
  const handleApprovePlan = useCallback(() => {
    if (!state.currentPlan) return;
    dispatch({ type: "APPROVE_PLAN", planId: state.currentPlan.id });
  }, [state.currentPlan]);
  
  const handleRejectPlan = useCallback(() => {
    if (!state.currentPlan) return;
    dispatch({ type: "REJECT_PLAN", planId: state.currentPlan.id });
  }, [state.currentPlan]);
  const pendingImagesRef = useRef<ImageAttachment[]>([]);
  pendingImagesRef.current = state.pendingImages;
  const promptQueueRef = useRef<string[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);
  const [input, setInput] = useState("");
  // Bump to remount the text input so ink-text-input resets cursorOffset to value.length
  // after programmatic completions (Tab @file / slash commands).
  const [inputEpoch, setInputEpoch] = useState(0);
  const historyRef = useRef<AgentMessage[]>(createAgentHistory(undefined, "plan"));
  const abortRef = useRef<AbortController>(new AbortController());
  const permissionManagerRef = useRef<PermissionManager | null>(null);
  const permissionTurnRef = useRef<PermissionTurnContext | null>(null);
  const planCaptureRef = useRef<{ prompt: string } | null>(null);
  const execCaptureRef = useRef<{ mode: "run" | "retry" } | null>(null);
  const pendingPermissionRef = useRef(false);
  pendingPermissionRef.current = Boolean(state.pendingPermission);
  // Profile state
  const [pendingProfileSetup, setPendingProfileSetup] = useState<{ model: ModelRef; baseUrl: string; apiKey: string } | null>(null);
  const [profileListState, setProfileListState] = useState<ProfileListState | null>(null);
  const [profileStore, setProfileStore] = useState<ModelProfileStore | null>(null);
  // ink-text-input still receives the same keystroke as useInput; after Ctrl/Alt+T
  // it may append "t" (or a control char). Swallow that one onChange tick.
  const suppressInputEchoRef = useRef(false);

  // Buffer deltas per turn so a late provider callback cannot update a newer
  // prompt after the current run has already ended.
  const streamBufferRef = useRef<TurnEventBuffer | null>(null);
  if (!streamBufferRef.current) {
    streamBufferRef.current = new TurnEventBuffer((event) => {
      dispatch({ type: "LOOP_EVENT", event });
    });
  }

  const turnCount = state.messages.filter((message) => message.kind === "user").length;
  const permissionSessionId = "tui_session";

  const getPermissionManager = useCallback(() => {
    return permissionManagerRef.current ?? (permissionManagerRef.current = new PermissionManager("plan"));
  }, []);

  const addPendingImage = useCallback((image: ImageAttachment): boolean => {
    const current = pendingImagesRef.current;
    if (current.some((item) => item.path === image.path)) return true;
    if (current.length >= MAX_TUI_IMAGES) {
      dispatch({ type: "ATTACHMENT_ERROR", message: `最多可同时添加 ${MAX_TUI_IMAGES} 张图片` });
      return false;
    }
    pendingImagesRef.current = [...current, image];
    dispatch({ type: "ADD_PENDING_IMAGE", image });
    return true;
  }, []);

  const handlePasteImage = useCallback(async (): Promise<boolean> => {
    try {
      return addPendingImage(await readClipboardImage());
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      dispatch({ type: "ATTACHMENT_ERROR", message: `无法粘贴图片: ${detail}` });
      return false;
    }
  }, [addPendingImage]);

  // Cleanup buffered stream output on unmount.
  useEffect(() => {
    return () => {
      streamBufferRef.current?.dispose();
    };
  }, []);

  const setInputSafe = useCallback((value: string) => {
    if (pendingPermissionRef.current) return;
    // PromptInput ignores Ctrl/Meta chords, so do not swallow the next character.
    suppressInputEchoRef.current = false;
    setInput(sanitizeInput(value));
  }, []);

  // ── autocomplete state ───────────────────────────────────────────────────
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
  }, []);

  const resolvePendingPermission = useCallback((decision: PermissionDecision) => {
    const pending = state.pendingPermission;
    const permissionManager = permissionManagerRef.current;
    if (!pending || !permissionManager) return false;
    const resolved = permissionManager.resolve(pending.sessionId, pending.requestId, decision);
    if (resolved) {
      dispatch({ type: "CLEAR_PENDING_PERMISSION" });
    }
    return resolved;
  }, [dispatch, state.pendingPermission]);

  // Load profile store on mount
  useEffect(() => {
    loadProfileStore().then(setProfileStore).catch(() => { /* non-fatal */ });
  }, []);

  useEffect(() => {
    void discoverWorkspaceSkills(cwd).catch(() => { /* non-fatal */ });
  }, [cwd]);

  // Watch input → update autocomplete
  useEffect(() => {
    if (acDebounceRef.current) clearTimeout(acDebounceRef.current);

    if (acMode === "model-picker") {
      const choices = modelChoices(input);
      setModelQuery(input);
      setModelCandidates(choices.references);
      setModelContextWindows(choices.contextWindows);
      setAcIndex((index) => Math.min(index, Math.max(0, choices.references.length - 1)));
      return;
    }

    if (acMode === "model-setup") return;

    // Command palette: input starts with / and no space yet
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
      const query = modelTrigger[1] ?? "";
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

    // File autocomplete: @ref or /cmd <path>
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

    // No trigger → clear
    clearAc();

    return () => { if (acDebounceRef.current) clearTimeout(acDebounceRef.current); };
  }, [input, cwd, clearAc, acMode]);

  // Force the input cursor to the end of the (new) value. ink-text-input keeps an
  // internal cursorOffset and only clamps it when it exceeds the new length, so
  // lengthening the string via Tab autocomplete leaves the caret mid-token.
  const resetInputCursorToEnd = useCallback(() => {
    setInputEpoch((n) => n + 1);
  }, []);

  // Accept command candidate
  const acceptCommand = useCallback((idx: number) => {
    const cmd = cmdCandidates[idx];
    if (!cmd) return;
    if (PATH_COMMANDS.has(cmd.name)) {
      // Expand command and leave cursor after the space for path input
      setInput(`/${cmd.name} `);
      // File autocomplete will trigger on next render because of /read + space
    } else {
      setInput(`/${cmd.name}`);
      clearAc();
    }
    resetInputCursorToEnd();
    setAcMode(null);
    setCmdCandidates([]);
    setAcIndex(0);
  }, [cmdCandidates, clearAc, resetInputCursorToEnd]);

  // Accept file candidate
  const acceptFile = useCallback((idx: number) => {
    const trigger = fileTriggerRef.current;
    const chosen = fileCandidates[idx];
    if (!trigger || !chosen) return;
    setInput(trigger.replaceFn(chosen));
    resetInputCursorToEnd();
    clearAc();
  }, [fileCandidates, clearAc, resetInputCursorToEnd]);

  // Intercept Tab at input to immediately show file autocomplete
  const handleTabAt = useCallback((inputVal: string) => {
    // App.useInput already owns Tab while a picker is open.
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
  }, [acMode, cwd]);

  const openModelPicker = useCallback((query = "") => {
    const choices = modelChoices(query);
    setModelQuery(query);
    setModelCandidates(choices.references);
    setModelContextWindows(choices.contextWindows);
    setAcIndex(0);
    setInput(query);
    setAcMode("model-picker");
  }, []);

  const startModelSetup = useCallback((model: ModelRef, overrides: ModelSwitchOverrides = {}) => {
    const providerKey = model.apiKeyEnv
      .map((name) => process.env[name])
      .find((value): value is string => Boolean(value));
    const canReuseCurrentKey = model.provider === llm.provider && model.baseUrl === llm.baseUrl;
    setModelSetup({
      model,
      baseUrl: overrides.baseUrl || model.baseUrl,
      apiKey: overrides.apiKey ?? (canReuseCurrentKey ? llm.apiKey : providerKey ?? ""),
      field: "baseUrl",
    });
    setInput(overrides.baseUrl || model.baseUrl);
    setAcMode("model-setup");
    setAcIndex(0);
  }, [llm.apiKey, llm.baseUrl, llm.provider]);

  const commitModelSetup = useCallback(async (setup: ModelSetupState, apiKey: string) => {
    try {
      const newLlmConfig = switchLlmModel(llm, setup.model, {
        baseUrl: setup.baseUrl,
        apiKey,
      });
      setLlm(newLlmConfig);
      dispatch({ type: "MODEL_CHANGED", modelName: setup.model.id });

      // Adapt existing conversation history for the new model's capabilities
      if (historyRef.current.length > 1) {
        historyRef.current = adaptHistoryForModel(historyRef.current, {
          targetCapabilities: newLlmConfig.capabilities,
          sourceCapabilities: llm.capabilities,
        });
      }

      setModelSetup(undefined);
      setAcMode(null);
      setInput("");
      // Auto-save as a named profile (fire-and-forget, non-fatal)
      const defaultName = `${setup.model.provider}-${setup.model.id}`
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 40);
      try {
        const updated = await saveProfile(defaultName, {
          model: `${setup.model.provider}/${setup.model.id}`,
          baseUrl: setup.baseUrl,
          apiKey,
          thinkingLevel: newLlmConfig.thinkingLevel,
        });
        setProfileStore(updated);
      } catch { /* non-fatal: model is already switched in memory */ }
    } catch (error) {
      setModelSetup({ ...setup, apiKey, error: error instanceof Error ? error.message : String(error) });
      setInput(apiKey);
    }
  }, []);

  const openProfileList = useCallback(async () => {
    try {
      const store = await loadProfileStore();
      setProfileStore(store);
      const profiles = listProfiles(store);
      setProfileListState({ profiles, selectedIndex: 0 });
      setAcMode("profile-list");
      setInput("");
    } catch {
      // ignore
    }
  }, []);

  const selectModel = useCallback((reference: string, overrides: ModelSwitchOverrides = {}) => {
    const match = findExactModelReferenceMatch(reference, getAllModels());
    if (!match) {
      // An unknown id is a valid custom OpenAI-compatible model. Let the
      // user configure its gateway instead of trapping them in an empty picker.
      startModelSetup(resolveModel(reference, overrides.baseUrl), overrides);
      return;
    }
    if (match.ambiguous || !match.model) {
      const choices = modelChoices("", match.matches);
      setModelQuery(reference);
      setModelCandidates(choices.references);
      setModelContextWindows(choices.contextWindows);
      setAcIndex(0);
      setInput(reference);
      setAcMode("model-picker");
      return;
    }
    startModelSetup(match.model, overrides);
  }, [startModelSetup]);

  // Match Codex's direct effort controls: the active model stays fixed and
  // only the next supported reasoning level is applied for subsequent turns.
  const adjustThinkingLevel = useCallback((direction: "increase" | "decrease", wrap = false) => {
    if (state.busy || state.pendingPermission) return;
    const current = llmRef.current;
    const nextLevel = cycleThinkingLevel(current, direction, { wrap });
    const next = withThinkingLevel(current, nextLevel);
    llmRef.current = next;
    setLlm(next);
    dispatch({ type: "SET_STATUS", status: `思考强度: ${thinkingLevelToDisplay(nextLevel)}` });
  }, [state.busy, state.pendingPermission]);

  const requestedPickerItems =
    acMode === "command" ? Math.min(6, cmdCandidates.length)
      : acMode === "file" ? Math.min(8, fileCandidates.length)
        : acMode === "model" || acMode === "model-picker" ? Math.min(12, modelCandidates.length)
          : acMode === "profile-list" ? Math.min(10, profileListState?.profiles.length ?? 0)
            : acMode ? 4 : 0;
  const pickerLayout = getPickerLayout({
    termRows: stdout?.rows,
    requestedItems: requestedPickerItems,
    hasPendingImages: state.pendingImages.length > 0,
    extraRows: acMode === "model" || acMode === "model-picker" || acMode === "file" ? 3 : 2,
  });
  const feedHeight = getMessageFeedHeight({
    termRows: stdout?.rows,
    hasPendingImages: state.pendingImages.length > 0,
    pickerRows: pickerLayout.totalRows,
  });

  // ── keyboard handler ─────────────────────────────────────────────────────

  useInput((_ch: string, key: Key) => {
    if (key.ctrl && (_ch === "c" || _ch === "C")) { abortRef.current.abort(); exit(); return; }

    // Commit the runtime mode first. This also rejects pending approvals and
    // aborts the active turn before the UI state is updated.
    if (!acMode && key.shift && key.tab) {
      suppressInputEchoRef.current = true;
      const permissionManager = getPermissionManager();
      const current = PERMISSION_MODES.indexOf(permissionManager.getMode());
      const next = PERMISSION_MODES[(current + 1) % PERMISSION_MODES.length] ?? "plan";
      permissionManager.setMode(next);
      dispatch({ type: "SET_PERMISSION_MODE", mode: next });
      return;
    }

    if (state.pendingPermission) {
      pendingPermissionRef.current = true;
      const decision = resolvePendingPermissionDecision(_ch, key);
      if (decision) {
        resolvePendingPermission(decision);
        return;
      }
      return;
    }
    pendingPermissionRef.current = false;
    
    // Plan approval shortcuts when in review phase
    if (!acMode && !state.busy && state.phase === "review" && state.currentPlan) {
      if (_ch === "a" || _ch === "A") {
        suppressInputEchoRef.current = true;
        dispatch({ type: "APPROVE_PLAN", planId: state.currentPlan.id });
        return;
      }
      if (_ch === "r" || _ch === "R") {
        suppressInputEchoRef.current = true;
        dispatch({ type: "REJECT_PLAN", planId: state.currentPlan.id });
        return;
      }
    }

    // Codex-compatible effort shortcuts:
    // Shift+↑/↓ and Alt+./, change one level without touching the prompt.
    if (!acMode && !state.busy && key.shift && key.upArrow) {
      suppressInputEchoRef.current = true;
      adjustThinkingLevel("increase");
      return;
    }
    if (!acMode && !state.busy && key.shift && key.downArrow) {
      suppressInputEchoRef.current = true;
      adjustThinkingLevel("decrease");
      return;
    }
    if (!acMode && !state.busy && key.meta && (_ch === "." || _ch === ",") && !key.ctrl) {
      suppressInputEchoRef.current = true;
      adjustThinkingLevel(_ch === "." ? "increase" : "decrease");
      return;
    }

    // Ctrl+R is the quick path: cycle through all levels supported by the
    // active model, wrapping from the last level back to the first.
    if (!acMode && !state.busy && key.ctrl && (_ch === "r" || _ch === "R" || _ch === "\u0012")) {
      suppressInputEchoRef.current = true;
      adjustThinkingLevel("increase", true);
      return;
    }

    // Ctrl+T: cycle global thinking mode (hidden → summary → full)
    // Some terminals report ctrl+t as input="t" + key.ctrl, others as a control char.
    if (key.ctrl && (_ch === "t" || _ch === "T" || _ch === "\u0014")) {
      suppressInputEchoRef.current = true;
      dispatch({ type: "TOGGLE_THINKING_MODE" });
      return;
    }
    // Alt+T: toggle expand/collapse of focused (or last) reasoning message.
    if (key.meta && (_ch === "t" || _ch === "T") && !key.ctrl) {
      suppressInputEchoRef.current = true;
      dispatch({ type: "TOGGLE_MESSAGE_THINKING" });
      return;
    }
    // Alt+↑ / Alt+↓: move focus among reasoning messages
    if (!acMode && key.meta && key.upArrow) {
      dispatch({ type: "FOCUS_NEXT_REASONING", direction: -1 });
      return;
    }
    if (!acMode && key.meta && key.downArrow) {
      dispatch({ type: "FOCUS_NEXT_REASONING", direction: 1 });
      return;
    }

    // Message history scrolling (does not steal autocomplete navigation).
    // PageUp/PageDown and Ctrl+↑/↓ move a bottom-anchored window over history.
    if (!acMode) {
      if (key.pageUp) {
        dispatch({ type: "SCROLL_BY", delta: Math.max(1, feedHeight - 2) });
        return;
      }
      if (key.pageDown) {
        dispatch({ type: "SCROLL_BY", delta: -Math.max(1, feedHeight - 2) });
        return;
      }
      if (key.ctrl && key.upArrow) {
        dispatch({ type: "SCROLL_BY", delta: 1 });
        return;
      }
      if (key.ctrl && key.downArrow) {
        dispatch({ type: "SCROLL_BY", delta: -1 });
        return;
      }
      // Ctrl+G jumps back to the latest messages (stick-to-bottom).
      if (key.ctrl && (_ch === "g" || _ch === "G")) {
        suppressInputEchoRef.current = true;
        dispatch({ type: "SCROLL_TO_BOTTOM" });
        return;
      }
    }
    if (acMode === "profile-name") {
      if (key.escape) {
        // User skipped saving — just clear
        setInput("");
        clearAc();
      }
      return;
    }

    if (acMode === "profile-list" && profileListState) {
      const len = profileListState.profiles.length;
      if (key.upArrow && len > 0) {
        setProfileListState((s) => s ? { ...s, selectedIndex: (s.selectedIndex - 1 + len) % len } : s);
        return;
      }
      if (key.downArrow && len > 0) {
        setProfileListState((s) => s ? { ...s, selectedIndex: (s.selectedIndex + 1) % len } : s);
        return;
      }
      if (key.escape) {
        setInput("");
        clearAc();
        return;
      }
      return;
    }

    if (acMode === "model-setup") {
      if (key.escape) {
        setInput("");
        clearAc();
      }
      return;
    }

    if (acMode === "command") {
      const len = cmdCandidates.length;
      if (key.upArrow)   { setAcIndex((i) => (i - 1 + len) % len); return; }
      if (key.downArrow) { setAcIndex((i) => (i + 1) % len); return; }
      if (key.tab)       { acceptCommand(acIndex); return; }
      if (key.escape)    { clearAc(); return; }
      return;
    }

    if (acMode === "file") {
      const len = fileCandidates.length;
      if (key.upArrow)   { setAcIndex((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setAcIndex((i) => Math.min(len - 1, i + 1)); return; }
      if (key.tab || key.rightArrow) { acceptFile(acIndex); return; }
      if (key.escape)    { clearAc(); return; }
    }

    if (acMode === "model" || acMode === "model-picker") {
      const len = modelCandidates.length;
      if (key.upArrow && len > 0) { setAcIndex((i) => (i - 1 + len) % len); return; }
      if (key.downArrow && len > 0) { setAcIndex((i) => (i + 1) % len); return; }
      if (key.tab) {
        const chosen = modelCandidates[acIndex];
        if (chosen) {
          setInput(`/model ${chosen}`);
          resetInputCursorToEnd();
          clearAc();
        }
        return;
      }
      if (key.escape) { setInput(""); clearAc(); return; }
    }
  });

  // ── direct tool invocation ────────────────────────────────────────────────

  const runDirectTool = useCallback(async (toolName: string, args: Record<string, unknown>) => {
    const tool = resolveToolProvider(allToolsRef.current).find((t) => t.name === toolName);
    const fakeCall = { id: `direct-${Date.now()}`, name: toolName, arguments: args };
    if (!tool) {
      dispatch({ type: "LOOP_EVENT", event: { type: "tool_end", call: fakeCall, result: { content: `Unknown tool: ${toolName}`, isError: true } } });
      return;
    }
    dispatch({ type: "LOOP_EVENT", event: { type: "tool_start", call: fakeCall } });
    const permissionManager = getPermissionManager();
    const permissionTurn = permissionManager.beginTurn(
      permissionSessionId,
      (request) => dispatch({ type: "LOOP_EVENT", event: { type: "permission_required", request } }),
      abortRef.current.signal,
    );
    try {
      const result = await permissionTurn.execute(tool, args);
      dispatch({ type: "LOOP_EVENT", event: { type: "tool_end", call: fakeCall, result } });
    } catch (err) {
      dispatch({ type: "LOOP_EVENT", event: { type: "tool_end", call: fakeCall, result: { content: err instanceof Error ? err.message : String(err), isError: true } } });
    } finally {
      permissionTurn.close();
    }
  }, [getPermissionManager]);

  // ── @file resolver ────────────────────────────────────────────────────────

  const resolveAtRefs = useCallback(async (text: string, permissionTurn: PermissionTurnContext): Promise<MessageContent> => {
    const paths = parseAtRefs(text);
    if (paths.length === 0) return text;
    const readTool = resolveToolProvider(allToolsRef.current).find((t) => t.name === "read");
    if (!readTool) return text;
    const parts: MessageContent = [{ type: "text", text }];
    for (const p of paths) {
      try {
        const result = await permissionTurn.execute(readTool, { path: p });
        const content = typeof result.content === "string" ? result.content : "";
        parts.push({ type: "text", text: `\n\n[File: ${p}]\n\`\`\`\n${content}\n\`\`\`` });
      } catch (error) {
        if (error instanceof PermissionModeChangedError || permissionTurn.signal.aborted) throw error;
        /* Keep unresolved references out of the model prompt. */
      }
    }
    return parts;
  }, []);

  // ── submit handler ────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async (text: string) => {
    const trimmed = text.trim();
    const allowEmptyApiKey = acMode === "model-setup" && modelSetup?.field === "apiKey";
    const hasPendingImages = pendingImagesRef.current.length > 0;
    if (!trimmed && !allowEmptyApiKey && !hasPendingImages) return;
    if (state.busy) {
      if (trimmed) {
        promptQueueRef.current.push(trimmed);
        setQueuedCount(promptQueueRef.current.length);
        setInput("");
      }
      return;
    }

    // Profile name step: save the new/updated profile
    if (acMode === "profile-name" && pendingProfileSetup) {
      const profileName = trimmed || "default";
      try {
        const updated = await saveProfile(profileName, {
          model: `${pendingProfileSetup.model.provider}/${pendingProfileSetup.model.id}`,
          baseUrl: pendingProfileSetup.baseUrl,
          apiKey: pendingProfileSetup.apiKey,
          thinkingLevel: llm.thinkingLevel,
        });
        setProfileStore(updated);
      } catch { /* non-fatal */ }
      setPendingProfileSetup(null);
      setInput("");
      setAcMode(null);
      return;
    }

    // Profile list: activate selected profile on Enter
    if (acMode === "profile-list" && profileListState) {
      const selected = profileListState.profiles[profileListState.selectedIndex];
      if (selected) {
        try {
          const updated = await activateProfile(selected.name);
          setProfileStore(updated);
          const previousLlm = llm;
          const newLlm = loadLlmConfigFromEnv();
          setLlm(newLlm);
          dispatch({ type: "MODEL_CHANGED", modelName: newLlm.model });
          // Adapt existing conversation history for the new model's capabilities
          if (historyRef.current.length > 1) {
            historyRef.current = adaptHistoryForModel(historyRef.current, {
              targetCapabilities: newLlm.capabilities,
              sourceCapabilities: previousLlm.capabilities,
            });
          }
        } catch { /* non-fatal */ }
      }
      setInput("");
      clearAc();
      return;
    }

    if (acMode === "model-setup" && modelSetup) {
      if (modelSetup.field === "baseUrl") {
        const baseUrl = trimmed.replace(/\/$/, "");
        setModelSetup({ ...modelSetup, baseUrl, field: "apiKey", error: undefined });
        setInput(modelSetup.apiKey);
      } else {
        void commitModelSetup(modelSetup, trimmed);
      }
      return;
    }

    clearAc();

    if (trimmed === "/exit" || trimmed === "/quit") { exit(); return; }
    if (trimmed === "/clear") {
      historyRef.current = createAgentHistory(undefined, getPermissionManager().getMode());
      pendingImagesRef.current = [];
      dispatch({ type: "RESET" });
      setInput("");
      // Generate new conversation ID for fresh session
      setConversationId(randomUUID());
      return;
    }
    if (trimmed === "/context") {
      const compactions = state.contextCompactions;
      const tokenEst = state.contextTokens;
      const ctxWindow = modelContextWindows[state.modelName] ?? llm.contextWindow ?? 128000;
      const pct = ctxWindow > 0 ? Math.round(tokenEst / ctxWindow * 100) : 0;
      const lines = [
        `上下文统计: ${tokenEst} / ${ctxWindow} tokens (${pct}%)`,
        '',
      ];
      if (compactions.length === 0) {
        lines.push('尚无压缩记录（上下文未超过阈值）');
      } else {
        lines.push(`已压缩 ${compactions.length} 次:`);
        for (const c of compactions.slice(-5)) {
          lines.push(`  turn${c.turn}: ${c.before} → ${c.after} (${c.reason})`);
        }
      }
      dispatch({ type: "ADD_NOTICE", title: "上下文统计", text: lines.join("\n") });
      setInput("");
      return;
    }

    if (/^\/paste-image$/i.test(trimmed)) {
      setInput("");
      await handlePasteImage();
      return;
    }

    // /image <path> - add pending image
    const imageMatch = trimmed.match(/^\/image\s+(.+)$/i);
    if (imageMatch) {
      const imagePath = imageMatch[1]!.trim();
      if (imagePath.toLowerCase() === "clear") {
        pendingImagesRef.current = [];
        dispatch({ type: "CLEAR_PENDING_IMAGES" });
        setInput("");
        return;
      }
      try {
        addPendingImage(await loadImageAttachment(imagePath, cwd));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        dispatch({ type: "ATTACHMENT_ERROR", message: `无法添加图片: ${detail}` });
      }
      setInput("");
      return;
    }
    if (trimmed === "/help" || trimmed === "/?") {
      dispatch({
        type: "ADD_NOTICE",
        title: "可用命令",
        text: SLASH_COMMANDS.map((command) => `${command.usage.padEnd(28)} ${command.description}`).join("\n"),
      });
      setInput("");
      return;
    }

    const skillCommand = applySkillCommand(trimmed, skillNamesRef.current);
    if (skillCommand) {
      setSkillNames(skillCommand.activation.activeNames);
      dispatch({
        type: "ADD_NOTICE",
        title: "Skills",
        text: skillCommand.message,
      });
      setInput("");
      return;
    }

    // ── Plan workflow slash commands ───────────────────────────────────────
    if (trimmed === "/plan-show") {
      setInput("");
      try {
        const doc = await loadPlanDocument(cwd);
        if (!doc) {
          dispatch({ type: "ADD_NOTICE", title: "计划", text: "当前没有保存的计划。使用 /plan <任务> 生成。" });
        } else {
          dispatch({ type: "ADD_NOTICE", title: "当前计划", text: formatPlanDocumentPreview(doc) });
        }
      } catch (err) {
        dispatch({ type: "ADD_NOTICE", title: "计划错误", text: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (trimmed === "/plan-approve") {
      setInput("");
      try {
        const doc = await approveCurrentPlan(cwd, "user");
        dispatch({
          type: "ADD_NOTICE",
          title: "计划已批准",
          text: `id=${doc.id} status=${doc.status}\n\n${formatPlanDocumentPreview(doc)}`,
        });
      } catch (err) {
        dispatch({ type: "ADD_NOTICE", title: "计划错误", text: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (trimmed === "/plan-reject") {
      setInput("");
      try {
        const doc = await rejectCurrentPlan(cwd);
        dispatch({ type: "ADD_NOTICE", title: "计划已拒绝", text: `id=${doc.id} status=${doc.status}` });
      } catch (err) {
        dispatch({ type: "ADD_NOTICE", title: "计划错误", text: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (trimmed === "/plan-history") {
      setInput("");
      try {
        const history = await listPlanHistory(cwd);
        if (history.length === 0) {
          dispatch({ type: "ADD_NOTICE", title: "计划历史", text: "尚无归档计划。" });
        } else {
          const lines = history.map((doc) => {
            const promptSlice = doc.prompt.length > 60 ? `${doc.prompt.slice(0, 60)}…` : doc.prompt;
            return `${doc.id}  ${doc.status.padEnd(10)}  ${doc.updatedAt}  ${promptSlice}`;
          });
          dispatch({ type: "ADD_NOTICE", title: "计划历史", text: lines.join("\n") });
        }
      } catch (err) {
        dispatch({ type: "ADD_NOTICE", title: "计划错误", text: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (trimmed === "/plan-archive") {
      setInput("");
      try {
        const { archivedPath, document } = await archiveCurrentPlan(cwd);
        dispatch({
          type: "ADD_NOTICE",
          title: "计划已归档",
          text: `id=${document.id}\npath=${archivedPath}`,
        });
      } catch (err) {
        dispatch({ type: "ADD_NOTICE", title: "计划错误", text: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // Plan generation / execution may fall through into the normal agent turn.
    // These overrides let slash commands reuse the existing run path.
    let planTurnOverride: {
      displayText: string;
      prompt: string;
      forceMode?: PermissionMode;
      restoreMode?: PermissionMode;
    } | null = null;

    // /plan [task] — generate a plan via agent turn in plan mode
    const planMatch = trimmed.match(/^\/plan(?:\s+(.*))?$/i);
    if (planMatch && !trimmed.startsWith("/plan-")) {
      const task = (planMatch[1] ?? "").trim();
      if (!task) {
        setInput("");
        try {
          const doc = await loadPlanDocument(cwd);
          if (doc) {
            dispatch({ type: "ADD_NOTICE", title: "当前计划", text: formatPlanDocumentPreview(doc) });
          } else {
            dispatch({ type: "ADD_NOTICE", title: "计划", text: "用法: /plan <任务>" });
          }
        } catch (err) {
          dispatch({ type: "ADD_NOTICE", title: "计划错误", text: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      planCaptureRef.current = { prompt: task };
      execCaptureRef.current = null;
      const permissionManager = getPermissionManager();
      if (permissionManager.getMode() !== "plan") {
        permissionManager.setMode("plan");
        dispatch({ type: "SET_PERMISSION_MODE", mode: "plan" });
      }
      planTurnOverride = {
        displayText: `/plan ${task}`,
        prompt: task + PLAN_ONLY_SUFFIX,
        forceMode: "plan",
      };
    }

    // /plan-run and /plan-retry — execute approved plan in bypass mode
    if (!planTurnOverride && (trimmed === "/plan-run" || trimmed === "/plan-retry")) {
      const isRetry = trimmed === "/plan-retry";
      let executionPromptSuffix: string;
      try {
        const prepared = await preparePlanForExecution(cwd, {
          yes: false,
          workspaceRoot: cwd,
        });
        executionPromptSuffix = prepared.executionPromptSuffix;
        dispatch({
          type: "ADD_NOTICE",
          title: isRetry ? "重试计划" : "执行计划",
          text: `id=${prepared.document.id} status=executing\nprompt: ${prepared.document.prompt}`,
        });
      } catch (err) {
        setInput("");
        dispatch({ type: "ADD_NOTICE", title: "计划错误", text: err instanceof Error ? err.message : String(err) });
        return;
      }

      execCaptureRef.current = { mode: isRetry ? "retry" : "run" };
      planCaptureRef.current = null;
      const permissionManager = getPermissionManager();
      const previousMode = permissionManager.getMode();
      if (previousMode !== "bypass") {
        permissionManager.setMode("bypass");
        dispatch({ type: "SET_PERMISSION_MODE", mode: "bypass" });
      }
      planTurnOverride = {
        displayText: trimmed,
        prompt: `Execute the approved plan.${executionPromptSuffix}`,
        forceMode: "bypass",
        restoreMode: previousMode,
      };
    }

    // /profiles: show profile list
    if (/^\/profiles?$/i.test(trimmed)) {
      await openProfileList();
      return;
    }

    // /profiles delete <name>
    const profileDeleteMatch = trimmed.match(/^\/profiles?\s+delete\s+(.+)$/i);
    if (profileDeleteMatch) {
      const name = profileDeleteMatch[1]!.trim();
      try {
        const updated = await removeProfile(name);
        setProfileStore(updated);
        dispatch({ type: "LOOP_EVENT", event: { type: "tool_end", call: { id: "profiles-delete", name: "profiles delete", arguments: {} }, result: { content: `Profile "${name}" deleted.`, isError: false } } });
      } catch (err) {
        dispatch({ type: "LOOP_EVENT", event: { type: "tool_end", call: { id: "profiles-delete", name: "profiles delete", arguments: {} }, result: { content: err instanceof Error ? err.message : String(err), isError: true } } });
      }
      setInput("");
      dispatch({ type: "LOOP_EVENT", event: { type: "done", messages: historyRef.current } });
      return;
    }

    if (/^\/model(?:\s+.*)?$/i.test(trimmed)) {
      const parsed = parseModelCommand(trimmed.replace(/^\/model\s*/i, ""));
      if (!parsed.reference) {
        setInput("");
        openModelPicker();
      } else {
        const match = findExactModelReferenceMatch(parsed.reference, getAllModels());
        if (match?.model && !match.ambiguous) selectModel(parsed.reference, parsed.overrides);
        else openModelPicker(parsed.reference);
      }
      return;
    }

    // Slash commands → direct tool
    const slashCmd = parseSlashCommand(trimmed);
    if (slashCmd) {
      setInput("");
      dispatch({ type: "USER_MESSAGE", text: trimmed });
      switch (slashCmd.cmd) {
        case "read": await runDirectTool("read", { path: slashCmd.path }); break;
        case "bash": await runDirectTool("bash", { command: slashCmd.command }); break;
        case "ls":   await runDirectTool("ls",   { path: slashCmd.path }); break;
        case "find": await runDirectTool("find", { pattern: slashCmd.pattern, path: slashCmd.path }); break;
        case "grep": await runDirectTool("grep", { pattern: slashCmd.pattern, path: slashCmd.path }); break;
      }
      dispatch({ type: "LOOP_EVENT", event: { type: "done", messages: historyRef.current } });
      return;
    }

    const pendingImgs = planTurnOverride ? [] : [...pendingImagesRef.current];
    if (!planTurnOverride && !trimmed && pendingImgs.length === 0) {
      setInput("");
      return;
    }
    const prompt = planTurnOverride?.prompt ?? (trimmed || DEFAULT_IMAGE_PROMPT);
    const parsedThinking = planTurnOverride
      ? { intensity: undefined as undefined }
      : parseThinkingIntensityPrompt(prompt);
    let turnLlm = parsedThinking.intensity
      ? buildIntenseLlm(llm, parsedThinking.intensity)
      : llm;
    if (parsedThinking.intensity) setLlm(turnLlm);
    let imageParts: import("../types.ts").ImagePart[];
    try {
      imageParts = await Promise.all(pendingImgs.map(imageAttachmentToPart));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      dispatch({ type: "ATTACHMENT_ERROR", message: `无法读取待发送图片: ${detail}` });
      return;
    }

    setInput("");
    pendingImagesRef.current = [];
    if (state.pendingImages.length > 0) dispatch({ type: "CLEAR_PENDING_IMAGES" });
    abortRef.current = new AbortController();
    const permissionManager = getPermissionManager();
    if (planTurnOverride?.forceMode && permissionManager.getMode() !== planTurnOverride.forceMode) {
      permissionManager.setMode(planTurnOverride.forceMode);
      dispatch({ type: "SET_PERMISSION_MODE", mode: planTurnOverride.forceMode });
    }
    const permissionTurn = permissionManager.beginTurn(
      permissionSessionId,
      (request) => dispatch({ type: "LOOP_EVENT", event: { type: "permission_required", request } }),
      abortRef.current.signal,
    );
    permissionTurnRef.current = permissionTurn;
    // Collapse multi-line pastes into a summary for display, but keep full text for model context.
    const displaySource = planTurnOverride?.displayText ?? prompt;
    const normalizedPrompt = displaySource.replace(/\r\n/g, '\n');
    const isMultiLine = !planTurnOverride && normalizedPrompt.includes('\n');
    const lineCount = isMultiLine ? normalizedPrompt.split('\n').length : 1;
    // Count graphemes properly (emoji = 1 char, not 2 UTF-16 units)
    const charCount = [...normalizedPrompt].length;
    const displayText = planTurnOverride
      ? planTurnOverride.displayText
      : isMultiLine
        ? `[已复制 ${lineCount} 行 / ${charCount} 字]`
        : undefined;
    dispatch({
      type: "USER_MESSAGE",
      text: planTurnOverride ? planTurnOverride.displayText : prompt,
      ...(displayText !== undefined && !planTurnOverride ? { displayText } : {}),
      images: pendingImgs,
    });

    const streamBuffer = streamBufferRef.current!;
    const runId = streamBuffer.start();
    const MAX_AUTO_CONTINUES = 5;
    let autoContinueCount = 0;
    let currentUserText = planTurnOverride
      ? prompt
      : prompt.replace(/@\S+/g, "").replace(/\s{2,}/g, " ").trim();
    const thinkingMode = planTurnOverride
      ? loadThinkingModeFromEnv()
      : parsedThinking.intensity
        ? "fixed"
        : parseThinkingCommandMode(prompt) ?? loadThinkingModeFromEnv();
    let turnSucceeded = false;
    let turnErrorMessage: string | undefined;

    const onLoopEvent = (event: LoopEvent) => {
      if (event.type === "thinking_policy") {
        turnLlm = withThinkingLevel(turnLlm, event.level);
        setLlm(turnLlm);
      } else if (event.type === "auto_subagent") {
        const status = event.executed
          ? `自动子 agent 已启动 (${event.profile}, score=${event.score})`
          : event.shouldDelegate
            ? `建议委托子 agent (${event.profile}, score=${event.score})`
            : `不自动委托 (score=${event.score})`;
        dispatch({ type: "SET_STATUS", status });
      } else if (event.type === "coordinator_mode") {
        dispatch({
          type: "SET_STATUS",
          status: event.active
            ? `编排模式: ${event.profile} (探索 ${event.directExplorationUsed}/${event.maxDirectExploration})`
            : "编排模式已关闭",
        });
      }
      streamBuffer.handle(runId, event);
    };

    try {
      let currentUserContent = planTurnOverride
        ? prompt
        : await resolveAtRefs(prompt, permissionTurn);
      if (imageParts.length > 0) {
        const contentParts = typeof currentUserContent === "string"
          ? [{ type: "text" as const, text: currentUserContent }]
          : currentUserContent;
        currentUserContent = [...contentParts, ...imageParts];
      }


      // Auto-continue loop: re-invoke runAgentTurn when maxTurns is exceeded.
      while (true) {
        try {
          historyRef.current = await runAgentTurn(historyRef.current, currentUserText, {
            llm: { ...turnLlm, sessionId: conversationId },
            tools: () => [...resolveToolProvider(agentToolsRef.current), ...getSubagentTools(turnLlm)],
            autoSubagent,
            preprocessors: vision ? [createVisionPreprocessor(vision)] : [],
            signal: abortRef.current.signal,
            userContent: currentUserContent,
            permissionTurn,
            autoValidate: process.env.MINI_AGENT_AUTO_VALIDATE === "1",
            validationWorkspace: cwd,
            autoCheckpoint: process.env.MINI_AGENT_AUTO_CHECKPOINT === "1",
            thinkingMode,
            runtimeRef: subagentRuntimeRef.current,
            skillNames: skillNamesRef.current,
            skillRegistry: defaultSkillRegistry,
            onEvent: onLoopEvent,
          });
          streamBuffer.finish(runId);
          turnSucceeded = true;
          break;
        } catch (err) {
          if (err instanceof MaxTurnsExceededError) {
            historyRef.current = err.messages;
            autoContinueCount++;
            if (autoContinueCount >= MAX_AUTO_CONTINUES || permissionTurn.signal.aborted) {
              streamBuffer.finish(runId);
              turnErrorMessage = permissionTurn.signal.aborted
                ? "aborted"
                : `已达到自动续跑上限 (${MAX_AUTO_CONTINUES} 次)`;
              if (permissionTurn.signal.aborted) {
                const reason = permissionTurn.signal.reason;
                dispatch({
                  type: "LOOP_EVENT",
                  event: reason instanceof PermissionModeChangedError
                    ? {
                        type: "aborted",
                        messages: historyRef.current,
                        reason: "permission_mode_changed",
                        previousMode: reason.previousMode,
                        permissionMode: reason.mode,
                      }
                    : { type: "aborted", messages: historyRef.current },
                });
              } else {
                dispatch({ type: "LOOP_EVENT", event: { type: "error", message: turnErrorMessage } });
              }
              break;
            }
            currentUserText = "继续完成之前的工作";
            currentUserContent = currentUserText;
            dispatch({ type: "AUTO_CONTINUE", count: autoContinueCount, max: MAX_AUTO_CONTINUES });
            continue;
          }
          if (err instanceof LlmTimeoutError && err.messages) {
            // Timeout with partial content: save the partial history so the next
            // turn starts from the known state instead of losing the streamed output.
            historyRef.current = err.messages;
            streamBuffer.finish(runId);
            turnErrorMessage = `LLM timeout — partial response saved (${err.partialContent?.substring(0, 80) || ""})`;
            dispatch({ type: "LOOP_EVENT", event: { type: "error", message: turnErrorMessage } });
            break;
          }
          throw err;
        }
      }
    } catch (err) {
      streamBuffer.finish(runId);
      turnErrorMessage = err instanceof Error ? err.message : String(err);
      if (err instanceof PermissionModeChangedError || permissionTurn.signal.aborted) {
        const reason = permissionTurn.signal.reason;
        dispatch({
          type: "LOOP_EVENT",
          event: reason instanceof PermissionModeChangedError
            ? {
                type: "aborted",
                messages: historyRef.current,
                reason: "permission_mode_changed",
                previousMode: reason.previousMode,
                permissionMode: reason.mode,
              }
            : { type: "aborted", messages: historyRef.current },
        });
      } else {
        dispatch({ type: "LOOP_EVENT", event: { type: "error", message: turnErrorMessage } });
      }
    } finally {
      if (permissionTurnRef.current === permissionTurn) permissionTurnRef.current = null;
      permissionTurn.close();

      // Restore permission mode after plan execution turns.
      if (planTurnOverride?.restoreMode !== undefined) {
        const restore = planTurnOverride.restoreMode;
        if (permissionManager.getMode() !== restore) {
          permissionManager.setMode(restore);
          dispatch({ type: "SET_PERMISSION_MODE", mode: restore });
        }
      }

      // After a /plan generation turn, persist the assistant answer as a plan document.
      if (planCaptureRef.current) {
        const capture = planCaptureRef.current;
        planCaptureRef.current = null;
        if (turnSucceeded) {
          const lastAssistant = [...historyRef.current].reverse().find((m) => m.role === "assistant");
          const answer = lastAssistant && lastAssistant.role === "assistant" ? lastAssistant.content : "";
          if (answer.trim()) {
            try {
              const doc = await createAndSavePlan(cwd, capture.prompt, answer);
              dispatch({
                type: "ADD_NOTICE",
                title: "计划已保存",
                text: `id=${doc.id} status=${doc.status}\n\n${formatPlanDocumentPreview(doc)}\n\n使用 /plan-approve 批准，然后 /plan-run 执行。`,
              });
            } catch (err) {
              dispatch({
                type: "ADD_NOTICE",
                title: "计划保存失败",
                text: err instanceof Error ? err.message : String(err),
              });
            }
          } else {
            dispatch({ type: "ADD_NOTICE", title: "计划", text: "Agent 未返回可保存的计划内容。" });
          }
        }
      }

      // After a /plan-run or /plan-retry turn, mark execution result.
      if (execCaptureRef.current) {
        execCaptureRef.current = null;
        try {
          if (turnSucceeded) {
            const lastAssistant = [...historyRef.current].reverse().find((m) => m.role === "assistant");
            const summary =
              lastAssistant && lastAssistant.role === "assistant"
                ? String(lastAssistant.content).slice(0, 500)
                : undefined;
            const completed = await markPlanExecutionResult(cwd, {
              ok: true,
              summary,
              workspaceRoot: cwd,
            });
            const audit = completed.execution?.auditReport
              ? `\n${completed.execution.auditReport.slice(0, 400)}`
              : "";
            dispatch({
              type: "ADD_NOTICE",
              title: "计划执行完成",
              text: `id=${completed.id} status=${completed.status}${audit}`,
            });
          } else {
            const failed = await markPlanExecutionResult(cwd, {
              ok: false,
              error: turnErrorMessage ?? "execution failed",
              workspaceRoot: cwd,
            });
            const audit = failed.execution?.auditReport
              ? `\n${failed.execution.auditReport.slice(0, 400)}`
              : "";
            dispatch({
              type: "ADD_NOTICE",
              title: "计划执行失败",
              text: `id=${failed.id} status=${failed.status}\n${turnErrorMessage ?? ""}${audit}`,
            });
          }
        } catch (err) {
          dispatch({
            type: "ADD_NOTICE",
            title: "计划结果记录失败",
            text: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }, [state.busy, acMode, modelSetup, pendingProfileSetup, profileListState, llm, vision, exit, runDirectTool, resolveAtRefs, clearAc, commitModelSetup, openProfileList, getPermissionManager, addPendingImage, handlePasteImage, conversationId, cwd]);

  // Start the next queued prompt only after the current turn has emitted done/error/aborted.
  useEffect(() => {
    if (state.busy || promptQueueRef.current.length === 0) return;
    const next = promptQueueRef.current.shift();
    setQueuedCount(promptQueueRef.current.length);
    if (next) void handleSubmit(next);
  }, [state.busy, handleSubmit]);

  // ── render ────────────────────────────────────────────────────────────────

  const viewportContentHeight = estimateViewportContentHeight({
    messages: state.messages,
    streamingText: state.streamingText,
    streamingReasoning: state.streamingReasoning,
    busy: state.busy,
    thinkingMode: state.thinkingMode,
    expandedThinking: state.expandedThinking,
    width: termWidth,
    maxMessages: 200,
  });
  const previousViewportHeightRef = useRef(viewportContentHeight);
  useLayoutEffect(() => {
    const previous = previousViewportHeightRef.current;
    previousViewportHeightRef.current = viewportContentHeight;
    if (state.scrollOffset > 0 && viewportContentHeight > previous) {
      dispatch({ type: "SCROLL_BY", delta: viewportContentHeight - previous });
    }
  }, [viewportContentHeight, state.scrollOffset]);

  return (
    <Box flexDirection="column" width={termWidth} height={termHeight} overflow="hidden">
      <Header />

      <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
        <MessageFeed
          messages={state.messages}
          streamingText={state.streamingText}
          streamingReasoning={state.streamingReasoning}
          thinkingMode={state.thinkingMode}
          expandedThinking={state.expandedThinking}
          focusedMessageIndex={state.focusedMessageIndex}
          busy={state.busy}
          status={state.status}
          availableHeight={feedHeight}
          width={termWidth}
          scrollOffset={state.scrollOffset}
        />
        {/* Keep transient pickers in the dynamic region so they cannot push the
            input and status bar outside the fixed terminal viewport. */}
        {acMode === "command" && (
          <CommandPalette
            filter={input.slice(1)}
            selectedIndex={acIndex}
            candidates={cmdCandidates}
            maxVisible={pickerLayout.itemRows}
          />
        )}

        {acMode === "file" && (
          <FileAutocomplete
            candidates={fileCandidates}
            selectedIndex={acIndex}
            prefix={fileFragment}
            maxVisible={pickerLayout.itemRows}
          />
        )}

        {(acMode === "model" || acMode === "model-picker") && (
          <ModelPicker
            candidates={modelCandidates}
            contextWindows={modelContextWindows}
            selectedIndex={acIndex}
            query={modelQuery}
            current={`${llm.provider}/${llm.model}`}
            maxVisible={pickerLayout.itemRows}
          />
        )}

        {acMode === "model-setup" && modelSetup && (
          <Box flexDirection="column" paddingX={2}>
            <Text color={C.primary} bold>── 配置模型 ──</Text>
            <Text>模型: {modelSetup.model.provider}/{modelSetup.model.id}</Text>
            <Text dimColor>Base URL: {modelSetup.field === "baseUrl" ? "正在编辑" : modelSetup.baseUrl}</Text>
            <Text dimColor>API Key: {modelSetup.field === "apiKey" ? "正在编辑" : "已设置"}</Text>
            {modelSetup.error && <Text color={C.error}>{modelSetup.error}</Text>}
            <Text dimColor>Enter 确认当前字段，Esc 取消</Text>
          </Box>
        )}

        {acMode === "profile-name" && pendingProfileSetup && (
          <Box flexDirection="column" paddingX={2}>
            <Text color={C.primary} bold>── 保存配置文件 ──</Text>
            <Text>模型: {pendingProfileSetup.model.provider}/{pendingProfileSetup.model.id}</Text>
            <Text dimColor>输入配置文件名称（Enter 保存，Esc 跳过）:</Text>
          </Box>
        )}

        {acMode === "profile-list" && profileListState && (
          <Box flexDirection="column" paddingX={2}>
            <Text color={C.primary} bold>── 配置文件列表 ──</Text>
            {profileListState.profiles.length === 0 && <Text dimColor>无已保存的配置文件</Text>}
            {(() => {
              const count = Math.max(1, pickerLayout.itemRows);
              const start = Math.max(0, Math.min(
                profileListState.selectedIndex - count + 1,
                profileListState.profiles.length - count,
              ));
              const visible = profileListState.profiles.slice(start, start + count);
              return <>
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
                  <Text dimColor>显示 {start + 1}-{start + visible.length} / {profileListState.profiles.length}</Text>
                )}
              </>;
            })()}
            <Text dimColor>↑↓ 选择，Enter 激活，Esc 取消，/profiles delete &lt;name&gt; 删除</Text>
          </Box>
        )}
      </Box>

      <Box flexDirection="column" flexShrink={0}>
        {state.pendingImages.length > 0 && (
          <Box paddingX={1} gap={1}>
            {state.pendingImages.map((img, idx) => (
              <Text key={idx} color={C.user}>
                🖼️ {img.path.split("/").pop()}
              </Text>
            ))}
          </Box>
        )}
        <Box paddingX={1} gap={1} flexShrink={0}>
          <Text color={state.busy ? C.running : C.user} bold>{state.busy ? "⟳" : ">"}</Text>
          <Box flexGrow={1} minWidth={0}>
            <PromptInput
              key={inputEpoch}
              value={input}
              onChange={setInputSafe}
              onPasteImage={handlePasteImage}
              onTab={handleTabAt}
              pasteEnabled={!state.pendingPermission}
              focus={!state.pendingPermission}
              mask={acMode === "model-setup" && modelSetup?.field === "apiKey" ? "*" : undefined}
              onSubmit={(val) => {
                if (shouldAcceptAutocompleteOnEnter(acMode)) {
                  if (acMode === "command") {
                    acceptCommand(acIndex);
                    return;
                  }
                  if (acMode === "file") {
                    acceptFile(acIndex);
                    return;
                  }
                  const chosen = modelCandidates[acIndex];
                  if (chosen) {
                    if (acMode === "model-picker") selectModel(chosen);
                    else {
                      setInput(`/model ${chosen}`);
                      resetInputCursorToEnd();
                      clearAc();
                    }
                    return;
                  }
                }
                void handleSubmit(val);
              }}
              placeholder={
                state.busy ? "运行中，可输入消息并排队"
                  : acMode === "model-picker" ? "搜索模型"
                    : acMode === "model-setup" && modelSetup?.field === "baseUrl" ? "输入 Base URL"
                      : acMode === "model-setup" ? "输入 API Key，可留空使用环境变量"
                        : acMode === "profile-name" ? "输入配置文件名称（例如 coding-fast）"
                          : acMode === "profile-list" ? "↑↓ 选择配置文件，Enter 激活"
                            : "输入消息，/ 命令，或 @文件 引用"
              }
            />
            {state.busy && queuedCount > 0 && <Text color={C.running}>队列 {queuedCount}</Text>}
          </Box>
        </Box>
        <StatusBar
          modelName={state.modelName}
          tokenEstimate={state.usedTokens || state.contextTokens}
          contextWindow={llm.contextWindow}
          cwd={cwd}
          busy={state.busy}
          status={state.status}
          queuedCount={queuedCount}
          permissionMode={state.permissionMode}
          thinkingLevel={llm.thinkingLevel ?? (llm.reasoning ? "medium" : "off")}
          cacheReadTokens={state.cacheReadTokens}
          promptTokens={state.contextTokens}
        />
      </Box>
    </Box>
  );
}
