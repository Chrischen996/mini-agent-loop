import React, { useReducer, useState, useCallback, useRef, useEffect, useMemo, useLayoutEffect } from "react";
import { randomUUID } from "node:crypto";
import { Box, Text, useApp, useInput, useStdout, type Key } from "ink";
import { MessageFeed } from "./components/MessageFeed.tsx";
import { Header } from "./components/Header.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { resolvePendingPermissionDecision } from "./pending-permission.ts";
import { SLASH_COMMANDS } from "./components/FileAutocomplete.tsx";
import { parseSlashCommand } from "./slash-commands.ts";
import { useAutocomplete } from "./hooks/useAutocomplete.ts";
import { tuiReducer, createInitialState } from "./state.ts";
import {
  buildSystemPrompt,
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
import { findExactModelReferenceMatch, getAllModels, resolveModel, type ModelRef } from "../models.ts";
import {
  hasGatewayOverrides,
  parseModelCommand,
  shouldSubmitTypedModelCommand,
} from "./model-command.ts";
import {
  activateProfile,
  listProfiles,
  loadProfileStore,
  removeProfile,
  saveProfile,
} from "../profile-store.ts";
import {
  createVisionPreprocessor,
  loadVisionConfigFromEnv,
} from "../preprocessors/index.ts";
import { createAllTools, createTools } from "../tools/index.ts";
import { resolveToolProvider, type Tool, type ToolProvider } from "../tools/types.ts";
import type { AgentMessage, MessageContent } from "../types.ts";
import type { ImageAttachment } from "./state.ts";
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
  parseAtRefs,
  sanitizeInput,
  shouldAcceptAutocompleteOnEnter,
} from "./input-utils.ts";
import {
  imageAttachmentToPart,
  loadImageAttachment,
  MAX_TUI_IMAGES,
  readClipboardImage,
} from "./image-attachments.ts";
import { writeClipboardText } from "./clipboard.ts";
import { formatCopyResultNotice, parseCopyCommand, resolveCopyTarget } from "./copy-text.ts";
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

import { Overlays } from "./components/Overlays.tsx";
import type { ModelSetupState } from "./types.ts";

type AppProps = { cwd: string; agentTools?: ToolProvider; allTools?: ToolProvider };
const DEFAULT_IMAGE_PROMPT = "请分析附件中的图片";

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

  // ── autocomplete hook ────────────────────────────────────────────────────
  const resetInputCursorToEnd = useCallback(() => {
    setInputEpoch((n) => n + 1);
  }, []);

  const {
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
  } = useAutocomplete({
    input,
    cwd,
    setInput,
    resetInputCursorToEnd,
  });

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

  useEffect(() => {
    void discoverWorkspaceSkills(cwd).catch(() => { /* non-fatal */ });
  }, [cwd]);

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
  }, [llm.apiKey, llm.baseUrl, llm.provider, setModelSetup, setAcMode, setAcIndex]);

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
        await saveProfile(defaultName, {
          model: `${setup.model.provider}/${setup.model.id}`,
          baseUrl: setup.baseUrl,
          apiKey,
          thinkingLevel: newLlmConfig.thinkingLevel,
        });
      } catch { /* non-fatal: model is already switched in memory */ }
    } catch (error) {
      setModelSetup({ ...setup, apiKey, error: error instanceof Error ? error.message : String(error) });
      setInput(apiKey);
    }
  }, []);

  const openProfileList = useCallback(async () => {
    try {
      const store = await loadProfileStore();
      const profiles = listProfiles(store);
      setProfileListState({ profiles, selectedIndex: 0 });
      setAcMode("profile-list");
      setInput("");
    } catch {
      // ignore
    }
  }, []);

  const selectModel = useCallback((reference: string, overrides: ModelSwitchOverrides = {}) => {
    const applyModel = (model: ModelRef) => {
      if (hasGatewayOverrides(overrides)) {
        void commitModelSetup({
          model,
          baseUrl: overrides.baseUrl!,
          apiKey: overrides.apiKey!,
          field: "apiKey",
        }, overrides.apiKey!);
        return;
      }
      startModelSetup(model, overrides);
    };
    const match = findExactModelReferenceMatch(reference, getAllModels());
    if (!match) {
      // An unknown id is a valid custom OpenAI-compatible model. Let the
      // user configure its gateway instead of trapping them in an empty picker.
      applyModel(resolveModel(reference, overrides.baseUrl));
      return;
    }
    if (match.ambiguous || !match.model) {
      openModelPicker(reference, match.matches);
      return;
    }
    applyModel(match.model);
  }, [commitModelSetup, openModelPicker, startModelSetup]);

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

  const copyResolvedText = useCallback(async (target: import("./copy-text.ts").CopyTarget = "auto") => {
    const selection = resolveCopyTarget({
      messages: state.messages,
      focusedIndex: state.focusedMessageIndex,
      streamingText: state.streamingText,
      streamingReasoning: state.streamingReasoning,
      input,
      target,
    });
    if (!selection) {
      dispatch({ type: "ADD_NOTICE", title: "复制", text: "没有可复制的原文。可用 /copy last、/copy tool 或先聚焦一条消息。" });
      return;
    }
    const result = await writeClipboardText(selection.text);
    dispatch({
      type: "ADD_NOTICE",
      title: result.ok ? "已复制到剪贴板" : "复制失败",
      text: result.ok
        ? formatCopyResultNotice(selection, result.method)
        : (result.error ?? "无法写入系统剪贴板"),
    });
  }, [input, state.focusedMessageIndex, state.messages, state.streamingReasoning, state.streamingText]);

  // ── keyboard handler ─────────────────────────────────────────────────────

  useInput((_ch: string, key: Key) => {
    if (key.ctrl && (_ch === "c" || _ch === "C")) { abortRef.current.abort(); exit(); return; }
    
    // ESC: Cancel current LLM generation (but don't exit program)
    if (key.escape && state.busy && !acMode) {
      abortRef.current.abort();
      // Create new AbortController for next request
      abortRef.current = new AbortController();
      dispatch({ type: "CANCEL_GENERATION" });
      return;
    }
    
    if (!acMode && key.ctrl && (_ch === "y" || _ch === "Y" || _ch === "\u0019")) {
      suppressInputEchoRef.current = true;
      void copyResolvedText("auto");
      return;
    }

    // Commit the runtime mode first. This also rejects pending approvals and
    // aborts the active turn before the UI state is updated.
    if (!acMode && key.shift && key.tab) {
      suppressInputEchoRef.current = true;
      const permissionManager = getPermissionManager();
      const current = PERMISSION_MODES.indexOf(permissionManager.getMode());
      const next = PERMISSION_MODES[(current + 1) % PERMISSION_MODES.length] ?? "plan";
      permissionManager.setMode(next);
      dispatch({ type: "SET_PERMISSION_MODE", mode: next });
      // also refresh system prompt in current history so next turn picks it up immediately
      if (historyRef.current.length > 0) {
        const newPrompt = buildSystemPrompt(next);
        historyRef.current = createAgentHistory(newPrompt, next);
      }
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
    if (handleAutocompleteKey(key)) return;
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
        await saveProfile(profileName, {
          model: `${pendingProfileSetup.model.provider}/${pendingProfileSetup.model.id}`,
          baseUrl: pendingProfileSetup.baseUrl,
          apiKey: pendingProfileSetup.apiKey,
          thinkingLevel: llm.thinkingLevel,
        });
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
          await activateProfile(selected.name);
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
    const copyTarget = parseCopyCommand(trimmed);
    if (copyTarget) {
      setInput("");
      await copyResolvedText(copyTarget);
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
    // Extracted as local helper for readability
    const handlePlanTurnOverride = async (): Promise<{
      displayText: string;
      prompt: string;
      forceMode?: PermissionMode;
      restoreMode?: PermissionMode;
    } | null | undefined> => {
      // /plan-show /plan-approve /plan-reject /plan-history /plan-archive — no agent turn
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
        return null;
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
        return null;
      }
      if (trimmed === "/plan-reject") {
        setInput("");
        try {
          const doc = await rejectCurrentPlan(cwd);
          dispatch({ type: "ADD_NOTICE", title: "计划已拒绝", text: `id=${doc.id} status=${doc.status}` });
        } catch (err) {
          dispatch({ type: "ADD_NOTICE", title: "计划错误", text: err instanceof Error ? err.message : String(err) });
        }
        return null;
      }
      if (trimmed === "/plan-history") {
        setInput("");
        try {
          const history = await listPlanHistory(cwd);
          if (history.length === 0) {
            dispatch({ type: "ADD_NOTICE", title: "计划历史", text: "尚无归档计划。" });
          } else {
            const lines = history.map((doc: any) => {
              const promptSlice = doc.prompt.length > 60 ? `${doc.prompt.slice(0, 60)}…` : doc.prompt;
              return `${doc.id}  ${doc.status.padEnd(10)}  ${doc.updatedAt}  ${promptSlice}`;
            });
            dispatch({ type: "ADD_NOTICE", title: "计划历史", text: lines.join("\n") });
          }
        } catch (err) {
          dispatch({ type: "ADD_NOTICE", title: "计划错误", text: err instanceof Error ? err.message : String(err) });
        }
        return null;
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
        return null;
      }

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
          return null;
        }
        planCaptureRef.current = { prompt: task };
        execCaptureRef.current = null;
        const permissionManager = getPermissionManager();
        if (permissionManager.getMode() !== "plan") {
          permissionManager.setMode("plan");
          dispatch({ type: "SET_PERMISSION_MODE", mode: "plan" });
        }
        return {
          displayText: `/plan ${task}`,
          prompt: task + PLAN_ONLY_SUFFIX,
          forceMode: "plan",
        };
      }

      // /plan-run and /plan-retry — execute approved plan in bypass mode
      if (trimmed === "/plan-run" || trimmed === "/plan-retry") {
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
          return null;
        }
        execCaptureRef.current = { mode: isRetry ? "retry" : "run" };
        planCaptureRef.current = null;
        const permissionManager = getPermissionManager();
        const previousMode = permissionManager.getMode();
        if (previousMode !== "bypass") {
          permissionManager.setMode("bypass");
          dispatch({ type: "SET_PERMISSION_MODE", mode: "bypass" });
        }
        return {
          displayText: trimmed,
          prompt: `Execute the approved plan.${executionPromptSuffix}`,
          forceMode: "bypass",
          restoreMode: previousMode,
        };
      }

      return undefined; // not a plan command
    };

    const planTurnOverride = await handlePlanTurnOverride() ?? null;

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
        await removeProfile(name);
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
        if (match?.ambiguous) openModelPicker(parsed.reference);
        else selectModel(parsed.reference, parsed.overrides);
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
        ? `[已折叠 ${lineCount} 行 / ${charCount} 字]`
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
  }, [state.busy, acMode, modelSetup, pendingProfileSetup, profileListState, llm, vision, exit, runDirectTool, resolveAtRefs, clearAc, commitModelSetup, openProfileList, getPermissionManager, addPendingImage, handlePasteImage, conversationId, cwd, copyResolvedText]);

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
        <Overlays
          acMode={acMode}
          input={input}
          acIndex={acIndex}
          cmdCandidates={cmdCandidates}
          fileCandidates={fileCandidates}
          fileFragment={fileFragment}
          modelCandidates={modelCandidates}
          modelContextWindows={modelContextWindows}
          modelQuery={modelQuery}
          currentModel={`${llm.provider}/${llm.model}`}
          modelSetup={modelSetup}
          pendingProfileSetup={pendingProfileSetup}
          profileListState={profileListState}
          pickerItemRows={pickerLayout.itemRows}
        />
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
                  if ((acMode === "model" || acMode === "model-picker") && shouldSubmitTypedModelCommand(val)) {
                    void handleSubmit(val);
                    return;
                  }
                  const chosen = modelCandidates[acIndex];
                  if (chosen) {
                    if (acMode === "model-picker") selectModel(chosen);
                    else acceptModel(acIndex);
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
