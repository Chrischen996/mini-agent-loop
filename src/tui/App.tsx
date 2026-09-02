import React, { useReducer, useState, useCallback, useRef, useEffect, useMemo, useLayoutEffect } from "react";
import { randomUUID } from "node:crypto";
import { Box, Text, useApp, useStdout } from "ink";
import { MessageFeed } from "./components/MessageFeed.tsx";
import { Header } from "./components/Header.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { TodoPanel } from "./components/TodoPanel.tsx";
import { getTodoPanelRows } from "./todo-format.ts";
import { SLASH_COMMANDS } from "./components/FileAutocomplete.tsx";
import { parseSlashCommand } from "./slash-commands.ts";
import { isExactSlashCommand } from "./autocomplete.ts";

/** Human-readable message for an LlmTimeoutError, with partial-response preview. */
function formatLlmTimeoutMessage(err: InstanceType<typeof LlmTimeoutError>): string {
  const phaseLabel = err.phase === "first_response"
    ? "first response"
    : err.phase === "stream_idle"
      ? "stream idle"
      : err.phase === "total"
        ? "total request"
        : "request";
  const duration = err.timeoutMs !== undefined ? `, ${Math.ceil(err.timeoutMs / 1000)}s` : "";
  const preview = err.partialContent?.replace(/\s+/g, " ").trim().slice(0, 80);
  return preview
    ? `LLM timeout (${phaseLabel}${duration}) - partial response saved: ${preview}`
    : `LLM timeout (${phaseLabel}${duration}) - no partial response received`;
}
import { useAutocomplete } from "./hooks/useAutocomplete.ts";
import { tuiReducer, createInitialState } from "./state.ts";
import {
  createAgentHistory,
  MaxTurnsExceededError,
  runAgentTurn,
  type AgentRuntimeRef,
  type LoopEvent,
} from "../loop.ts";
import { LlmTimeoutError } from "../llm/retry.ts";
import { loadLlmConfigFromEnv, type LlmConfig, type ModelSwitchOverrides } from "../llm/index.ts";
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
import { findExactModelReferenceMatch, getAllModels } from "../models.ts";
import {
  parseModelCommand,
  shouldSubmitTypedModelCommand,
} from "./model-command.ts";
import {
  activateProfile,
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
import { loadAutoSubagentOptionsFromEnv } from "../subagent/index.ts";
import type { SubagentEvent } from "../subagent/types.ts";
import {
  PermissionManager,
  PermissionModeChangedError,
  type PermissionDecision,
  type PermissionTurnContext,
} from "../permissions.ts";
import { TurnEventBuffer } from "./stream-buffer.ts";
import { getTuiViewportHeight, getMessageFeedHeight, getPickerLayout } from "./layout.ts";
import { estimateViewportContentHeight } from "./message-viewport.ts";
import { resolveAtRefs } from "./at-refs-resolver.ts";
import { runDirectTool } from "./direct-tool-runner.ts";
import { parseTodoCommand, todoViewModeForCommand } from "./todo-commands.ts";
import { addPendingImage, handlePasteImage } from "./image-handler.ts";
import { startModelSetup, commitModelSetup, openProfileList } from "./profile-manager.ts";
import { selectModel } from "./model-switcher.ts";
import { SubagentToolsFactory } from "./subagent-tools-factory.ts";
import { useKeyboardHandler } from "./hooks/useKeyboardHandler.ts";

import { TUI_COLORS as C } from "./theme.ts";
import { PromptInput } from "./components/PromptInput.tsx";
import {
  sanitizeInput,
  shouldAcceptAutocompleteOnEnter,
} from "./input-utils.ts";
import {
  imageAttachmentToPart,
  loadImageAttachment,
} from "./image-attachments.ts";
import { writeClipboardText } from "./clipboard.ts";
import { formatCopyResultNotice, parseCopyCommand, resolveCopyTarget } from "./copy-text.ts";
import {
  finalizeExecCapture,
  finalizePlanCapture,
  parsePlanTurnOverride,
} from "./plan-commands.ts";
import { loadPlanDocument } from "../plan/index.ts";
import {
  applySkillCommand,
  defaultSkillRegistry,
  discoverWorkspaceSkills,
  loadSkillNamesFromEnv,
} from "../skills/index.ts";

import { Overlays } from "./components/Overlays.tsx";
import { PermissionPanel } from "./components/PermissionPanel.tsx";
import { PlanApprovalBar } from "./components/PlanApprovalBar.tsx";
import type { RuntimeExecutionContext } from "../runtime/policy-types.ts";
import { loadGlobalConcurrencyLimitFromEnv, loadGlobalTokenBudgetFromEnv } from "../runtime/limits.ts";
import { isTuiFeatureEnabled } from "./execution-policy.ts";
import { SessionManager } from "../session-manager.ts";
import type { PersistedSessionMeta } from "../session-store.ts";
import { TUI_BRAND_VERSION } from "./brand.ts";
import { getWelcomeHeaderHeight } from "./welcome-panel.ts";
import { formatAmbiguousSessionNotice, getStartupSessionRequest, parseResumeCommand, resolveSessionByPrefix, restoreLlmConfig, restoreTuiSession, toPersistedTodos } from "./session-serialization.ts";

type AppProps = { cwd: string; agentTools?: ToolProvider; allTools?: ToolProvider };
const DEFAULT_IMAGE_PROMPT = "请分析附件中的图片";

export function App({ cwd, agentTools, allTools }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = Math.max(10, stdout?.columns || 80);
  // Leave two terminal rows unused. Ink's renderer adds a trailing newline and
  // can gain a row from borders/wrapping; staying below the terminal height
  // prevents its visible `clearTerminal` fallback during streamed updates.
  const termHeight = Math.max(1, (stdout?.rows || 24) - 2);
  const [llm, setLlm] = useState<LlmConfig>(() => loadLlmConfigFromEnv());
  const llmRef = useRef(llm);
  llmRef.current = llm;
  const startupSession = useMemo(() => getStartupSessionRequest(), []);
  const vision = loadVisionConfigFromEnv();
  const autoSubagent = useMemo(() => loadAutoSubagentOptionsFromEnv(), []);
  const globalTokenBudget = useMemo(() => loadGlobalTokenBudgetFromEnv(), []);
  const globalConcurrencyLimit = useMemo(() => loadGlobalConcurrencyLimitFromEnv(), []);
  const [skillNames, setSkillNames] = useState<string[]>(() => loadSkillNamesFromEnv());
  const skillNamesRef = useRef(skillNames);
  skillNamesRef.current = skillNames;
  const allToolsRef = useRef<ToolProvider>(allTools ?? createAllTools(cwd));
  const agentToolsRef = useRef<ToolProvider>(agentTools ?? createTools(cwd, { codebase: process.env.EXTERNAL_CODEBASE_ENABLED !== "0" }));

  // Create the subagent tool — dispatches SubagentEvents to the TUI reducer
  const subagentFactory = new SubagentToolsFactory();
  const subagentRuntimeRef = useRef<AgentRuntimeRef>({});
  const getSubagentTools = useCallback((parentLlm = llm): Tool[] => {
    return subagentFactory.getTools({
      parentLlm,
      parentTools: agentToolsRef.current,
      visionPreprocessors: vision ? [createVisionPreprocessor(vision)] : [],
      onSubagentEvent: (event: SubagentEvent) => {
        dispatch({ type: "SUBAGENT_EVENT", event });
      },
      getPermissionTurn: () => permissionTurnRef.current ?? undefined,
      parentRuntime: subagentRuntimeRef.current,
      globalTokenBudget,
      globalConcurrencyLimit,
    });
  }, [llm, vision]);

  const [state, dispatch] = useReducer(tuiReducer, createInitialState(llm.model));
  const stateRef = useRef(state);
  stateRef.current = state;
  // Generate a stable conversation session ID on startup
  // Startup --resume values can be prefixes. Allocate a safe fresh id until
  // the selected persisted session is resolved and activated below.
  const [conversationId, setConversationId] = useState<string>(() => randomUUID());
  const sessionManagerRef = useRef<SessionManager>();
  if (!sessionManagerRef.current) {
    sessionManagerRef.current = new SessionManager({ workspaceId: cwd, sessionId: conversationId });
  }
  const thinkingPolicyRef = useRef<"fixed" | "adaptive">(loadThinkingModeFromEnv());
  
  const pendingImagesRef = useRef<ImageAttachment[]>([]);
  pendingImagesRef.current = state.pendingImages;
  const promptQueueRef = useRef<string[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);
  const [input, setInput] = useState("");
  // Bump to remount the text input so ink-text-input resets cursorOffset to value.length
  // after programmatic completions (Tab @file / slash commands).
  const [inputEpoch, setInputEpoch] = useState(0);
  const historyRef = useRef<AgentMessage[]>(createAgentHistory(undefined, "plan"));
  const sessionRestoreCompletedRef = useRef(false);
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

  const permissionSessionId = conversationId;

  const getPermissionManager = useCallback(() => {
    return permissionManagerRef.current ?? (permissionManagerRef.current = new PermissionManager("plan"));
  }, []);

  const addPendingImageRef = useCallback((image: ImageAttachment): boolean => {
    return addPendingImage(image, { pendingImages: pendingImagesRef.current, pendingImagesRef, dispatch, cwd });
  }, [dispatch, cwd]);

  const handlePasteImageRef = useCallback(async (): Promise<boolean> => {
    return handlePasteImage({ pendingImages: pendingImagesRef.current, pendingImagesRef, dispatch, cwd });
  }, [dispatch, cwd]);

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
  const listSessions = useCallback(
    () => sessionManagerRef.current!.list(),
    [],
  );

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
    sessionCandidates,
    sessionCommand,
    sessionLoading,
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
    handleTabAt,
    handleAutocompleteKey,
    openModelPicker,
  } = useAutocomplete({
    input,
    cwd,
    setInput,
    resetInputCursorToEnd,
    listSessions,
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

  useEffect(() => {
    void loadPlanDocument(cwd)
      .then((plan) => {
        // A restored session's Todo snapshot wins over the workspace plan.
        if (sessionRestoreCompletedRef.current && stateRef.current.todoItems?.length) return;
        dispatch({ type: "SET_TODO_PLAN", plan: plan ?? undefined });
      })
      .catch(() => { /* a missing or unreadable plan is non-fatal */ });
  }, [cwd]);

  const persistSession = useCallback(async (history: AgentMessage[], id = conversationId): Promise<void> => {
    try {
      const sessionManager = sessionManagerRef.current!;
      const permissionMode = getPermissionManager().getMode();
      const currentState = stateRef.current;
      const todos = toPersistedTodos(currentState.todoItems ?? currentState.todos);
      await sessionManager.save({
        id,
        workspaceId: cwd,
        modelId: llmRef.current.model,
        thinkingLevel: llmRef.current.thinkingLevel,
        thinkingMode: thinkingPolicyRef.current,
        permissionMode,
        skillNames: skillNamesRef.current,
        phase: currentState.phase,
        currentPlan: currentState.currentPlan,
        messages: [...history],
        todos,
        todoVersion: currentState.todoRevision,
      });
    } catch {
      // Persistence is best-effort; a disk error must not break chat.
    }
  }, [conversationId, cwd, getPermissionManager]);

  const restoreSession = useCallback(async (
    requestedId?: string,
    fork = false,
    knownSession?: PersistedSessionMeta,
  ): Promise<import("../session-store.ts").PersistedSession | undefined> => {
    const sessionManager = sessionManagerRef.current!;
    const selection = knownSession
      ? { session: knownSession, candidates: [knownSession] }
      : requestedId
      ? resolveSessionByPrefix(await sessionManager.list(), requestedId)
      : resolveSessionByPrefix(await sessionManager.list(), "");
    if (!selection.session) {
      if (selection.candidates.length > 1) {
        dispatch({
          type: "ADD_NOTICE",
          title: "恢复会话",
          text: formatAmbiguousSessionNotice(requestedId ?? "", selection.candidates),
        });
      }
      return undefined;
    }
    let restored = await sessionManager.load(selection.session.id);
    if (restored && fork) restored = await sessionManager.fork(restored.id);
    if (!restored || restored.messages.length === 0) return undefined;
    sessionRestoreCompletedRef.current = true;
    const mode = restored.permissionMode ?? getPermissionManager().getMode();
    getPermissionManager().setMode(mode);
    const restoredLlm = restoreLlmConfig(llmRef.current, restored);
    llmRef.current = restoredLlm;
    setLlm(restoredLlm);
    thinkingPolicyRef.current = restored.thinkingMode ?? thinkingPolicyRef.current;
    if (restored.skillNames) setSkillNames([...restored.skillNames]);
    const base = createAgentHistory(undefined, mode);
    const systemPrompt = typeof base[0]?.content === "string" ? base[0].content : "";
    const restoredState = restoreTuiSession(
      restored,
      systemPrompt,
      (session, prompt) => sessionManager.restoreHistory(session, prompt),
    );
    historyRef.current = restoredState.history;
    sessionManager.setSessionId(restored.id);
    setConversationId(restored.id);
    dispatch({
      type: "RESTORE_SESSION",
      history: restoredState.history,
      permissionMode: mode,
      modelName: restoredLlm.model,
      thinkingMode: restored.thinkingMode === "adaptive" ? "hidden" : "summary",
      phase: restored.phase,
      currentPlan: restored.currentPlan,
      todos: restoredState.todos,
      todoRevision: restoredState.todoRevision,
    });
    return restored;
  }, [dispatch, getPermissionManager]);

  useEffect(() => {
    if (!startupSession.resume) return;
    void restoreSession(startupSession.sessionId, startupSession.fork).catch(() => { /* Resume is best-effort. */ });
  }, [restoreSession, startupSession]);

  // ── model switching ─────────────────────────────────────────────────────

  const selectModelRef = useCallback((reference: string, overrides: ModelSwitchOverrides = {}) => {
    return selectModel(reference, overrides, {
      openModelPicker,
      commitModelSetup: (setup, apiKey) => commitModelSetup(setup, apiKey, {
        llm, setLlm, setModelSetup, setAcMode, setInput, setAcIndex, setProfileListState, dispatch, historyRef,
      }),
      startModelSetup: (model, overrides) => startModelSetup(model, overrides, {
        llm, setLlm, setModelSetup, setAcMode, setInput, setAcIndex, setProfileListState, dispatch, historyRef,
      }),
    });
  }, [llm, setLlm, setModelSetup, setAcMode, setInput, setAcIndex, setProfileListState, dispatch, historyRef]);

  const openProfileListRef = useCallback(async () => {
    return openProfileList({ llm, setLlm, setModelSetup, setAcMode, setInput, setAcIndex, setProfileListState, dispatch, historyRef });
  }, [llm, setLlm, setModelSetup, setAcMode, setInput, setAcIndex, setProfileListState, dispatch, historyRef]);

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
          : acMode === "session-list" ? Math.max(1, Math.min(8, sessionCandidates.length))
          : acMode === "profile-list" ? Math.min(10, profileListState?.profiles.length ?? 0)
            : acMode ? 4 : 0;
  // Keep the product identity pinned above the transcript, including restored
  // sessions and active turns.
  const hasHeader = true;
  const showWelcome = state.messages.length === 0 && !state.busy && !state.pendingPermission;
  const headerRows = getWelcomeHeaderHeight(termWidth, showWelcome);
  const todoRows = getTodoPanelRows(
    { plan: state.todoPlan, todos: state.todoItems },
    state.todoViewMode,
  );
  // Approval chrome: the permission card / plan approval bar render between
  // the feed and the input row; reserve their rows in every height budget.
  // Ink's bordered approval cards include two border rows plus the content
  // rows below. Reserve their real footprint so streaming never pushes the
  // prompt onto the terminal's last row.
  const permissionRows = state.pendingPermission ? 6 : 0;
  const planApprovalRows = state.phase === "review" && state.currentPlan
    ? 6 + Math.min(4, state.currentPlan.steps.length) + (state.currentPlan.steps.length > 4 ? 1 : 0)
    : 0;
  const pickerLayout = getPickerLayout({
    termRows: stdout?.rows,
    hasHeader,
    headerRows,
    requestedItems: requestedPickerItems,
    hasPendingImages: state.pendingImages.length > 0,
    todoRows,
    extraRows: acMode === "model" || acMode === "model-picker" || acMode === "file" ? 3 : 2,
    permissionRows,
    planApprovalRows,
  });
  const feedHeight = getMessageFeedHeight({
    termRows: stdout?.rows,
    hasHeader,
    headerRows,
    hasPendingImages: state.pendingImages.length > 0,
    todoRows,
    pickerRows: pickerLayout.totalRows,
    permissionRows,
    planApprovalRows,
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

  useKeyboardHandler({
    exit, abortRef, copyResolvedText, pasteImage: handlePasteImageRef, getPermissionManager,
    adjustThinkingLevel, resolvePendingPermission, dispatch,
    acMode, state, feedHeight, handleAutocompleteKey, historyRef,
    suppressInputEchoRef, pendingPermissionRef,
  });

  // ── direct tool invocation ────────────────────────────────────────────────

  const runDirectToolRef = useCallback(async (toolName: string, args: Record<string, unknown>) => {
    return runDirectTool(toolName, args, { allTools: allToolsRef.current, permissionSessionId, getPermissionManager, abortSignal: abortRef.current.signal, dispatch });
  }, [getPermissionManager, abortRef, dispatch]);

  // ── @file resolver ────────────────────────────────────────────────────────

  const resolveAtRefsRef = useCallback(async (text: string, permissionTurn: PermissionTurnContext): Promise<MessageContent> => {
    return resolveAtRefs(text, permissionTurn, allToolsRef.current);
  }, [allToolsRef]);

  // ── submit handler ────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async (
    text: string,
    knownSession?: PersistedSessionMeta,
    knownSessions?: PersistedSessionMeta[],
  ) => {
    const trimmed = text.trim();
    const allowEmptyApiKey = acMode === "model-setup" && modelSetup?.field === "apiKey";
    const hasPendingImages = pendingImagesRef.current.length > 0;
    if (!trimmed && !allowEmptyApiKey && !hasPendingImages) return;
    if (state.busy) {
      if (/^(?:\/?resume)(?:\s|$)/i.test(trimmed)) {
        dispatch({ type: "ADD_NOTICE", title: "正在执行", text: "当前 turn 完成后才能恢复会话。" });
        setInput("");
        return;
      }
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
        void commitModelSetup(modelSetup, trimmed, {
          llm, setLlm, setModelSetup, setAcMode, setInput, setAcIndex, setProfileListState, dispatch, historyRef,
        });
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
      setConversationId(sessionManagerRef.current!.newSession());
      return;
    }
    if (trimmed === "/sessions") {
      const sessions = knownSessions ?? await sessionManagerRef.current!.list().catch(() => []);
      dispatch({
        type: "ADD_NOTICE",
        title: "会话列表",
        text: sessions.length === 0
          ? "没有可恢复的会话。"
          : sessions.slice(0, 8)
            .map((session) => session.id.slice(0, 8) + "  " + session.messageCount + " 条  " + session.preview)
            .join("\n"),
      });
      setInput("");
      return;
    }
    const resumeCommand = parseResumeCommand(trimmed);
    if (resumeCommand) {
      const prefix = resumeCommand.prefix;
      const sessions = knownSession
        ? [knownSession]
        : knownSessions ?? await sessionManagerRef.current!.list().catch(() => []);
      const selection = knownSession
        ? { session: knownSession, candidates: [knownSession] }
        : resolveSessionByPrefix(sessions, prefix);
      if (!selection.session && selection.candidates.length > 1) {
        dispatch({
          type: "ADD_NOTICE",
          title: "恢复会话",
          text: formatAmbiguousSessionNotice(prefix, selection.candidates),
        });
        setInput("");
        return;
      }
      const target = selection.session;
      if (!target) {
        dispatch({
          type: "ADD_NOTICE",
          title: "恢复会话",
          text: prefix ? "未找到会话: " + prefix : "没有可恢复的会话。",
        });
        setInput("");
        return;
      }
      const restored = await restoreSession(target.id, false, target);
      dispatch({
        type: "ADD_NOTICE",
        title: restored ? "会话已恢复" : "恢复会话失败",
        text: restored
          ? restored.id.slice(0, 8) + " · " + restored.messages.length + " 条消息"
          : "无法读取会话: " + target.id,
      });
      setInput("");
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

    const todoCommand = parseTodoCommand(trimmed);
    if (todoCommand) {
      if (todoCommand === "clear") {
        dispatch({ type: "CLEAR_TODO_ITEMS" });
      } else {
        dispatch({
          type: "SET_TODO_VIEW_MODE",
          mode: todoViewModeForCommand(todoCommand, state.todoViewMode),
        });
      }
      setInput("");
      return;
    }

    if (/^\/paste-image$/i.test(trimmed)) {
      setInput("");
      await handlePasteImageRef();
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
        addPendingImageRef(await loadImageAttachment(imagePath, cwd));
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

    const planTurnOverride = await parsePlanTurnOverride(trimmed, {
      cwd,
      dispatch,
      setInput,
      planCaptureRef,
      execCaptureRef,
      permissionManager: getPermissionManager(),
    });
    if (planTurnOverride === null) {
      return;
    }

    // /profiles: show profile list
    if (/^\/profiles?$/i.test(trimmed)) {
      await openProfileListRef();
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
        else selectModelRef(parsed.reference, parsed.overrides);
      }
      return;
    }

    // Slash commands → direct tool
    const slashCmd = parseSlashCommand(trimmed);
    if (slashCmd) {
      setInput("");
      dispatch({ type: "USER_MESSAGE", text: trimmed });
      switch (slashCmd.cmd) {
        case "read": await runDirectToolRef("read", { path: slashCmd.path }); break;
        case "bash": await runDirectToolRef("bash", { command: slashCmd.command }); break;
        case "ls":   await runDirectToolRef("ls",   { path: slashCmd.path }); break;
        case "find": await runDirectToolRef("find", { pattern: slashCmd.pattern, path: slashCmd.path }); break;
        case "grep": await runDirectToolRef("grep", { pattern: slashCmd.pattern, path: slashCmd.path }); break;
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
    dispatch({
      type: "USER_MESSAGE",
      text: planTurnOverride ? planTurnOverride.displayText : prompt,
      ...(planTurnOverride?.displayText !== undefined ? { displayText: planTurnOverride.displayText } : {}),
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
      ? thinkingPolicyRef.current
      : parsedThinking.intensity
        ? "fixed"
        : parseThinkingCommandMode(prompt) ?? thinkingPolicyRef.current;
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
      await persistSession([
        ...historyRef.current,
        { role: "user", content: currentUserText },
      ]);
      let currentUserContent = planTurnOverride
        ? prompt
        : await resolveAtRefsRef(prompt, permissionTurn);
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
            runtimeContext: {
              sessionId: conversationId,
              workspaceId: cwd,
            } satisfies RuntimeExecutionContext,
            globalTokenBudget,
            autoValidate: isTuiFeatureEnabled(process.env.MINI_AGENT_AUTO_VALIDATE),
            validationWorkspace: cwd,
            autoCheckpoint: isTuiFeatureEnabled(process.env.MINI_AGENT_AUTO_CHECKPOINT),
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
            turnErrorMessage = formatLlmTimeoutMessage(err);
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

      await persistSession(historyRef.current);

      await finalizePlanCapture({
        cwd,
        planCaptureRef,
        history: historyRef.current,
        succeeded: turnSucceeded,
        dispatch,
      });
      await finalizeExecCapture({
        cwd,
        execCaptureRef,
        history: historyRef.current,
        succeeded: turnSucceeded,
        errorMessage: turnErrorMessage,
        dispatch,
      });
    }
  }, [state, llm, vision, exit, runDirectToolRef, resolveAtRefsRef, clearAc, commitModelSetup, openProfileListRef, getPermissionManager, addPendingImageRef, handlePasteImageRef, conversationId, cwd, copyResolvedText, globalTokenBudget, globalConcurrencyLimit, persistSession, restoreSession]);

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
  // Do not force a short session to occupy the entire alternate screen. The
  // fixed-height viewport is useful once the transcript reaches the terminal
  // edge, but before that point it creates a large empty band above the prompt
  // (most noticeable while a restored session is still loading).
  const fixedChromeRows =
    (hasHeader ? headerRows : 0) +
    todoRows +
    pickerLayout.totalRows +
    permissionRows +
    planApprovalRows +
    (state.pendingImages.length > 0 ? 1 : 0) +
    (state.spinnerMessage ? 1 : 0) +
    2; // prompt + stable status row
  const naturalFrameHeight = Math.max(
    1,
    fixedChromeRows + Math.min(viewportContentHeight, feedHeight),
  );
  const frameHeight = Math.min(termHeight, naturalFrameHeight);
  const previousViewportHeightRef = useRef(viewportContentHeight);
  useLayoutEffect(() => {
    const previous = previousViewportHeightRef.current;
    previousViewportHeightRef.current = viewportContentHeight;
    if (state.scrollOffset > 0 && viewportContentHeight > previous) {
      dispatch({ type: "SCROLL_BY", delta: viewportContentHeight - previous });
    }
  }, [viewportContentHeight, state.scrollOffset]);

  return (
    <Box flexDirection="column" width={termWidth} height={frameHeight} overflow="hidden">
      {hasHeader && (
        <Header
          modelName={`${llm.provider}/${llm.model}`}
          billingLabel="API Usage Billing"
          version={TUI_BRAND_VERSION}
          cwd={cwd}
          width={termWidth}
          showWelcome={showWelcome}
        />
      )}

      {(state.todoPlan || state.todoItems) && (
        <TodoPanel
          plan={state.todoPlan}
          todos={state.todoItems}
          viewMode={state.todoViewMode}
          width={termWidth}
        />
      )}

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
          pendingPermission={state.pendingPermission}
          turnStartedAt={state.turnStartedAt}
          lastStreamAt={state.lastStreamAt}
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
          sessionCandidates={sessionCandidates}
          sessionCommand={sessionCommand}
          sessionLoading={sessionLoading}
          currentModel={`${llm.provider}/${llm.model}`}
          modelSetup={modelSetup}
          pendingProfileSetup={pendingProfileSetup}
          profileListState={profileListState}
          pickerItemRows={pickerLayout.itemRows}
          width={termWidth}
        />
      </Box>

      <Box flexDirection="column" flexShrink={0}>
        {state.pendingPermission && (
          <PermissionPanel request={state.pendingPermission} width={termWidth} />
        )}
        {state.phase === "review" && state.currentPlan && (
          <PlanApprovalBar plan={state.currentPlan} width={termWidth} />
        )}

        {state.pendingImages.length > 0 && (
          <Box paddingX={1} gap={1}>
            {state.pendingImages.map((img, idx) => (
              <Text key={idx} color={C.user}>
                🖼️ {img.path.split("/").pop()}
              </Text>
            ))}
          </Box>
        )}
        {state.spinnerMessage && (
          <Box paddingX={1} paddingY={0}>
            <Text dimColor>{state.spinnerMessage}</Text>
          </Box>
        )}
        <Box
          paddingX={1}
          gap={1}
          flexShrink={0}
        >
          <Text color={state.busy ? C.running : C.user} bold>{state.busy ? "⟳" : "❯"}</Text>
          <Box flexGrow={1} minWidth={0}>
            <PromptInput
              key={inputEpoch}
              value={input}
              onChange={setInputSafe}
              onPasteImage={handlePasteImageRef}
              onTab={handleTabAt}
              pasteEnabled={!state.pendingPermission}
              focus={!state.pendingPermission}
              mask={acMode === "model-setup" && modelSetup?.field === "apiKey" ? "*" : undefined}
              onSubmit={(val) => {
                if (shouldAcceptAutocompleteOnEnter(acMode)) {
                  if (acMode === "session-list") {
                    const selectedSession = sessionCandidates[acIndex];
                    if (selectedSession) {
                      void handleSubmit(`/resume ${selectedSession.id}`, selectedSession);
                    } else if (!sessionLoading) {
                      void handleSubmit(val, undefined, sessionCandidates);
                    } else {
                      // The picker owns the list request. Wait for it to
                      // settle instead of issuing a second scan on Enter.
                    }
                    return;
                  }
                  if (acMode === "command") {
                    const selectedCommand = cmdCandidates[acIndex];
                    if (selectedCommand && isExactSlashCommand(val, selectedCommand.name)) {
                      void handleSubmit(val);
                      return;
                    }
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
                    // Enter selects the model and starts the setup flow. Tab
                    // remains the completion-only path in useAutocomplete.
                    selectModelRef(chosen);
                    return;
                  }
                }
                void handleSubmit(val);
              }}
              placeholder={
                state.busy ? "Working; type a message to queue"
                  : acMode === "model-picker" ? "Search models"
                    : acMode === "model-setup" && modelSetup?.field === "baseUrl" ? "Enter Base URL"
                      : acMode === "model-setup" ? "Enter API key (or leave blank for env)"
                        : acMode === "profile-name" ? "Enter a profile name (for example coding-fast)"
                          : acMode === "profile-list" ? "↑↓ select profile, Enter activate"
                            : "Message, /command, or @file reference"
              }
            />
            {state.busy && queuedCount > 0 && <Text color={C.running}>Queued {queuedCount}</Text>}
          </Box>
        </Box>
        <StatusBar
          modelName={state.modelName}
          cwd={cwd}
          width={termWidth}
          tokenEstimate={state.contextTokens}
          contextWindow={llm.contextWindow}
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
