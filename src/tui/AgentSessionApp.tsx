// Per-session Ink view.
//
// One mounted instance per conversation: it owns the reducer, tool providers,
// subagent registry, stream bursts and layout budgets for a single agent, and
// reports a dashboard snapshot upward. `App.tsx` is the root container that
// keeps several of these alive (one visible, the rest mounted but inactive).
//
// Command routing lives in `session/command-cascade.ts`, turn execution in
// `session/turn-execution.ts`, stream emission in `hooks/useStreamBursts.ts`,
// and height budgets in `hooks/useSessionLayout.ts`.

import { randomUUID } from "node:crypto";
import React, { useReducer, useState, useCallback, useRef, useEffect, useMemo, useLayoutEffect, useSyncExternalStore } from "react";
import {
  Box,
  Text,
  useApp,
  useInput
} from "ink";
import { useTerminalSize } from "./hooks/useTerminalSize.ts";
import { useLazyRef } from "./hooks/useLazyRef.ts";
import { useGoalStatusTicker } from "./hooks/useGoalStatusTicker.ts";
import { runCommandCascade, type CommandCascadeContext } from "./session/command-cascade.ts";
import { importForeignSessionInTui, resumeSessionInTui, type SessionRestoreDeps } from "./session/session-restore.ts";
import { runSessionTurn } from "./session/turn-execution.ts";
import { useBackgroundWakeups } from "./hooks/useBackgroundWakeups.ts";
import { useStreamBursts } from "./hooks/useStreamBursts.ts";
import { useSessionLayout } from "./hooks/useSessionLayout.ts";
import { SubagentEventRouter } from "./subagent-event-router.ts";
import { buildSubagentToolsDeps } from "./subagent-tools-deps.ts";
import { buildTodosRunContext, resolveTodosRunArgs } from "./todos-run-context.ts";
import { MessageFeed } from "./components/MessageFeed.tsx";
import { Header } from "./components/Header.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { TodoPanel } from "./components/TodoPanel.tsx";
import { isExactSlashCommand } from "./autocomplete.ts";
import { useAutocomplete } from "./hooks/useAutocomplete.ts";
import { tuiReducer, createInitialState } from "./state.ts";
import { type AgentRuntimeRef } from "../loop.ts";
import { applyPermissionModePrompt } from "../loop/prompt.ts";
import { modeRequestContinuationPrompt, modeRequestLabel } from "./mode-request.ts";
import { loadLlmConfigFromEnv, type LlmConfig, type ModelSwitchOverrides } from "../llm/index.ts";
import {
  cycleThinkingLevel,
  getThinkingLevelChoices,
  getThinkingLevelChoicesForModel,
  thinkingLevelToDisplay,
  withThinkingLevel
} from "../think-intensity.ts";
import { THINKING_LEVEL_DISPLAY_LABELS } from "../pi-ai/thinking-levels.ts";
import type { ModelThinkingLevel } from "../pi-ai/types.ts";
import { loadThinkingModeFromEnv } from "../thinking-policy.ts";
import { adaptHistoryForModel } from "../message-adapter.ts";
import { shouldSubmitTypedModelCommand, modelCommandFromPickerInput } from "./model-command.ts";
import { activateProfile, saveProfile } from "../profile-store.ts";
import { createVisionPreprocessor, loadVisionConfigFromEnv } from "../preprocessors/index.ts";
import { createAllTools, createTools } from "../tools/index.ts";
import { type Tool } from "../tools/types.ts";
import type { AgentMessage, MessageContent } from "../types.ts";
import type { ImageAttachment } from "./state.ts";
import { loadAutoSubagentOptionsFromEnv } from "../subagent/index.ts";
import { SubagentTaskRegistry } from "../subagent/task-registry.ts";
import type { SubagentEvent } from "../subagent/types.ts";
import { PermissionManager, type PermissionDecision, type PermissionMode, type PermissionTurnContext } from "../permissions.ts";
import { TurnEventBuffer } from "./stream-buffer.ts";
import { getTuiViewportHeight } from "./layout.ts";
import { inputContainerBorderColor, usesInputBorder } from "./input-container.ts";
import { estimateViewportContentHeight, MessageHeightCache } from "./message-viewport.ts";
import { resolveTuiLayoutMode } from "./layout-mode.ts";
import { bootProbe } from "./boot-trace.ts";
import { applyTheme, persistThemeName, shouldPromptForThemeAtStartup } from "./theme.ts";
import { resolveAtRefs } from "./at-refs-resolver.ts";
import { runDirectTool } from "./direct-tool-runner.ts";
import { addPendingImage, handlePasteImage } from "./image-handler.ts";
import {
  activateSavedModelProfile,
  startModelSetup,
  commitModelSetup,
  deleteConfiguredModelProfile,
  openProfileList,
  resolveModelDeleteConfirmation
} from "./profile-manager.ts";
import { selectModel, type ModelSelectOptions } from "./model-switcher.ts";
import { SubagentToolsFactory } from "./subagent-tools-factory.ts";
import { toPersistedTodos } from "./session-serialization.ts";
import { SessionManager } from "../session-manager.ts";
import type { PersistedSession } from "../session-store.ts";
import { formatMcpStatus } from "../mcp/status.ts";
import { BgTaskManager, stableBgTaskInstanceId } from "../bg-tasks/manager.js";
import { GitWorkflow } from "../git/workflow.ts";
import { BgTaskLivePanel } from "./components/BgTaskLivePanel.tsx";
import { TasksPane } from "./components/TasksPane.tsx";
import { TodoRunPanel } from "./components/TodoRunPanel.tsx";
import { useKeyboardHandler } from "./hooks/useKeyboardHandler.ts";
import { SmoothScrollController } from "./smooth-scroll.ts";
import { TerminalInputHistory } from "./terminal-input-history.ts";
import { createTuiAgentHistory } from "./system-prompt.ts";
import { buildRoleLlmConfigs } from "./tui-core/bootstrap.ts";
import { serializeTuiModelConfig } from "./model-isolation.ts";

import { TUI_COLORS as C } from "./theme.ts";
import { createInputStore } from "./input-store.ts";
import { PromptInput } from "./components/PromptInput.tsx";
import { sanitizeInput, shouldAcceptAutocompleteOnEnter, type AcMode } from "./input-utils.ts";
import { writeClipboardText } from "./clipboard.ts";
import { formatCopyResultNotice, resolveCopyTarget } from "./copy-text.ts";
import { loadPlanDocument } from "../plan/index.ts";
import { runTodos, todosRunExecutors, type TodosRunExecutors } from "./tui-core/command-runners.ts";
import { discoverWorkspaceSkills, loadSkillNamesFromEnv } from "../skills/index.ts";

import { Overlays } from "./components/Overlays.tsx";
import { ThemeDialog } from "./components/ThemeDialog.tsx";
import { PermissionPanel } from "./components/PermissionPanel.tsx";
import { ModeRequestPanel } from "./components/ModeRequestPanel.tsx";
import { PlanApprovalBar } from "./components/PlanApprovalBar.tsx";
import {
  loadGlobalConcurrencyLimitFromEnv,
  loadGlobalGoalWorkerLimitFromEnv,
  loadGlobalTokenBudgetFromEnv,
  loadSessionSubagentConcurrencyLimitFromEnv
} from "../runtime/limits.ts";
import {
  attachGoalDiagnostics,
  backgroundGoalNotice,
  createGoalLog,
  createGoalSession,
  goalNotice,
  goalStatusSegmentElapsed,
  launchBackgroundGoal,
  parseGoalCommand,
  resolveGoalConfig,
  type GoalSessionContext,
  type GoalSnapshot
} from "../goal/index.ts";
import type { AgentSessionAppProps } from "./session/props.ts";

const DEFAULT_IMAGE_PROMPT = "Analyze the attached image";

export function AgentSessionApp({ cwd, projectCwd, systemPromptContext = {}, startupSessionRequest, agentTools, allTools, agentToolsForCwd, allToolsForCwd, bgManagerForCwd, mcpStatuses, mcpTools, mcpFailure, layoutMode, writeStaticBurst, requestClearScreen, setPinnedRows, agentId, initialSessionId, initialPrompt, active, dashboardOpen, onOpenDashboard, onCloseDashboard, onSnapshot, onWorkspaceChange }: AgentSessionAppProps): React.ReactElement | null {
  bootProbe("session-render");
  const effectiveLayoutMode = layoutMode ?? resolveTuiLayoutMode();
  // Document layout shares the inline burst pipeline; only its frame policy,
  // live-text projection and paragraph-level streaming commits differ.
  const isDocumentLayout = effectiveLayoutMode === "document";
  const usesStreamChannel = effectiveLayoutMode === "inline" || isDocumentLayout;
  const { exit } = useApp();
  const terminalSize = useTerminalSize();
  const termWidth = terminalSize.columns;
  // The Claude-style input container wraps the prompt in a two-row border.
  // Below 20 columns the border eats the text area, so fall back to the
  // borderless prompt row.
  const useClaudeStyleInputBorder = usesInputBorder(termWidth);
  // Leave one terminal row unused so Ink never enters its full-screen clear
  // path (`outputHeight >= rows`) while streamed reasoning is growing.
  const termHeight = getTuiViewportHeight(terminalSize.rows);
  const [llm, setLlm] = useState<LlmConfig>(() => loadLlmConfigFromEnv());
  const llmRef = useRef(llm);
  llmRef.current = llm;
  const goalConfig = useMemo(() => resolveGoalConfig(), []);
  const goalSessionRef = useRef<GoalSessionContext | null>(null);
  const [goalState, setGoalState] = useState<GoalSnapshot | null>(null);
  const vision = useMemo(() => loadVisionConfigFromEnv(), []);
  const autoSubagent = useMemo(() => loadAutoSubagentOptionsFromEnv(), []);
  const globalTokenBudget = useMemo(() => loadGlobalTokenBudgetFromEnv(), []);
  const globalConcurrencyLimit = useMemo(() => loadGlobalConcurrencyLimitFromEnv(), []);
  const sessionConcurrencyLimit = useMemo(() => loadSessionSubagentConcurrencyLimitFromEnv(), []);
  const [skillNames, setSkillNames] = useState<string[]>(() => loadSkillNamesFromEnv());
  const skillNamesRef = useRef(skillNames);
  skillNamesRef.current = skillNames;
  const allToolsRef = useLazyRef(() => allToolsForCwd?.(cwd) ?? allTools ?? createAllTools(cwd));
  const agentToolsRef = useLazyRef(() => agentToolsForCwd?.(cwd) ?? agentTools ?? createTools(cwd, {
    codebase: process.env.EXTERNAL_CODEBASE_ENABLED !== "0",
    // The Ink client can render the one-key confirmation card, so the model may
    // ask for a mode switch here. Headless entry points leave this off.
    modeRequest: true,
  }));
  useEffect(() => {
    if (allToolsForCwd) allToolsRef.current = allToolsForCwd(cwd);
    if (agentToolsForCwd) agentToolsRef.current = agentToolsForCwd(cwd);
  }, [cwd, allToolsForCwd, agentToolsForCwd]);

  // Lazy background-task manager for the /bg-tasks slash command. Created on
  // first use so TUI startup is not blocked when tmux is unavailable.
  const bgManagerRef = useRef<BgTaskManager | null | "unavailable">(null);
  const bgManagerOwnedRef = useRef(false);
  useEffect(() => {
    const manager = bgManagerRef.current;
    if (manager && manager !== "unavailable" && bgManagerOwnedRef.current) manager.dispose();
    bgManagerRef.current = null;
    bgManagerOwnedRef.current = false;
  }, [cwd, bgManagerForCwd]);
  const getBgManager = useCallback((): BgTaskManager | null => {
    if (bgManagerRef.current === "unavailable") return null;
    if (bgManagerRef.current) return bgManagerRef.current;
    if (bgManagerForCwd) {
      const manager = bgManagerForCwd(cwd);
      bgManagerRef.current = manager ?? "unavailable";
      return manager ?? null;
    }
    const bgEnabled = process.env.MINI_AGENT_BG_TASKS !== "0" && process.env.MINI_AGENT_BG_TASKS !== "false";
    if (!bgEnabled) {
      bgManagerRef.current = "unavailable";
      return null;
    }
    try {
      const instanceId = stableBgTaskInstanceId(cwd);
      bgManagerRef.current = new BgTaskManager(cwd, instanceId);
      bgManagerOwnedRef.current = true;
      return bgManagerRef.current;
    } catch {
      bgManagerRef.current = "unavailable";
      return null;
    }
  }, [cwd, bgManagerForCwd]);
  const [bgTaskCount, setBgTaskCount] = useState(0);
  const [bgPanelOpen, setBgPanelOpen] = useState(false);
  const [pendingTodoRunPlan, setPendingTodoRunPlan] = useState<import("./state.ts").PendingTodoRunPlan | undefined>(undefined);
  const confirmedTodoRunRef = useRef<import("./state.ts").PendingTodoRunPlan | undefined>(undefined);
  const refreshBgTaskCount = useCallback(async () => {
    const manager = getBgManager();
    if (!manager) return;
    try {
      await manager.initialize();
      const tasks = await manager.list();
      const count = tasks.filter((task) => task.status === "running" || task.status === "starting").length;
      setBgTaskCount(count);
    } catch {
      // Count is decorative; never fail the command on a read error.
    }
  }, [getBgManager]);
  // Poll while the badge is visible. The agent can start tasks without the
  // user ever running /bg-tasks, so the first count comes from the tool-event
  // listener below rather than from the slash command.
  useEffect(() => {
    const manager = getBgManager();
    if (!manager || bgTaskCount === 0) return;
    const timer = setInterval(() => void refreshBgTaskCount(), 1000);
    return () => clearInterval(timer);
  }, [bgTaskCount, getBgManager, refreshBgTaskCount]);
  // Create the subagent tool — dispatches SubagentEvents to the TUI reducer
  const subagentFactory = useLazyRef(() => new SubagentToolsFactory()).current;
  const subagentTaskRegistry = useLazyRef(() => new SubagentTaskRegistry(projectCwd)).current;
  const globalRoleLlmConfigs = useMemo(() => buildRoleLlmConfigs(llm), []);
  const localRoleLlmConfigsRef = useRef<Record<string, LlmConfig>>({});
  const subagentRuntimeRef = useRef<AgentRuntimeRef>({});
  const subagentEventRouter = useRef<SubagentEventRouter | null>(null);
  const getSubagentTools = useCallback((parentLlm = llm): Tool[] => {
    return subagentFactory.getTools(buildSubagentToolsDeps({
      parentLlm,
      parentTools: agentToolsRef.current,
      taskRegistry: subagentTaskRegistry,
      vision,
      onSubagentEvent: (event: SubagentEvent) => {
        // The router is built later in the render (after its refs are ready);
        // it is guaranteed to exist by the time sub-agent tools fire events.
        subagentEventRouter.current?.handle(event);
      },
      getPermissionTurn: () => permissionTurnRef.current ?? undefined,
      getBackgroundPermissionTurn: () => getPermissionManagerRef.current().beginTurn(
        permissionSessionId,
        (request) => dispatch({ type: "LOOP_EVENT", event: { type: "permission_required", request } }),
      ),
      parentRuntime: subagentRuntimeRef.current,
      globalTokenBudget,
      globalConcurrencyLimit,
      sessionConcurrencyLimit,
      roleLlmConfigs: globalRoleLlmConfigs,
      sessionRoleLlmConfigs: localRoleLlmConfigsRef.current,
      worktreeSourceCwd: projectCwd,
    }));
  }, [llm, vision, subagentTaskRegistry, projectCwd, sessionConcurrencyLimit]);

  // Executors for `/tasks run --parallel` (subagent + background tasks).
  const todosExecutorsRef = useRef<TodosRunExecutors | null>(null);
  const getTodosRunExecutors = useCallback((): TodosRunExecutors => {
    if (todosExecutorsRef.current) return todosExecutorsRef.current;
    todosExecutorsRef.current = todosRunExecutors({
      getBgManager,
      getSessionId: () => conversationIdRef.current,
      subagentFactory: subagentFactory as unknown as
        import("./subagent-tools-factory.ts").SubagentToolsFactoryDeps & {
          getTools: (deps: import("./subagent-tools-factory.ts").SubagentToolsFactoryDeps) => Tool[];
        },
      getSubagentTools: () =>
        getSubagentTools(llmRef.current).filter((t) => t.name === "subagent"),
    });
    return todosExecutorsRef.current;
  }, [getBgManager, getSubagentTools, subagentFactory]);

  const [state, dispatch] = useReducer(tuiReducer, createInitialState(llm.model));
  // Goal status-line text with a LOCALIZED 1 Hz tick: only this hook's state
  // updates every second while a goal is active and a turn is running; the
  // whole AgentSessionApp tree no longer re-renders on the beat (the tick used
  // to live in an App-level `nowMs` state).
  const goalNowMs = useGoalStatusTicker(goalState, state.busy);
  const goalStatus = useMemo(
    () => goalState && goalConfig.enabled
      ? goalStatusSegmentElapsed(goalState, state.busy ? goalNowMs : Date.now(), state.taskStartedAt)
      : undefined,
    [goalState, goalConfig.enabled, state.busy, goalNowMs, state.taskStartedAt],
  );
  const [foregroundCommandWaiting, setForegroundCommandWaiting] = useState(false);
  const [sendableWaitWaiting, setSendableWaitWaiting] = useState(false);
  const handleSubmitRef = useRef<(text: string) => Promise<void>>(async () => undefined);
  useEffect(() => {
    if (!active) {
      setForegroundCommandWaiting(false);
      return;
    }
    const manager = getBgManager();
    if (!manager) {
      setForegroundCommandWaiting(false);
      return;
    }
    const onWaitChanged = (waiting: boolean) => setForegroundCommandWaiting(waiting);
    manager.on("foreground-wait-changed", onWaitChanged);
    onWaitChanged(manager.isForegroundWaiting());
    return () => {
      manager.off("foreground-wait-changed", onWaitChanged);
    };
  }, [active, getBgManager]);
  const jumpToBottomRef = useRef<() => void>(() => undefined);
  const inputHistoryRef = useLazyRef(() => new TerminalInputHistory());
  // Generate a stable conversation session ID on startup
  const [conversationId, setConversationId] = useState(() => initialSessionId || process.env.MINI_AGENT_SESSION_ID || randomUUID());
  // /tasks-pane: this session's parallel tasks pane (subagents + background
  // tasks, Grok Build tasks_pane semantics). A conversation switch means a
  // new session, and the pane's task sets are per-session, so close it.
  const [tasksPaneOpen, setTasksPaneOpen] = useState(false);
  // Theme dialog state lives here because slash-command dispatch reads it.
  const [themeDialogOpen, setThemeDialogOpen] = useState<boolean>(() => active && shouldPromptForThemeAtStartup());
  const resizeRefreshRef = useRef(termWidth);
  useEffect(() => {
    setTasksPaneOpen(false);
  }, [conversationId]);

  // ── /tasks run /todos run --parallel runner ───────────────────────────────
  const runTodosCommand = useCallback(
    async (
      input: string,
      parsed: import("./slash-commands.ts").SlashCommand,
      confirmed = false,
    ) => {
      if (!parsed || parsed.cmd !== "todos-run") return;
      const approvedPlan = confirmed ? confirmedTodoRunRef.current : undefined;
      setInputRef.current("");
      jumpToBottomRef.current();
      dispatch({ type: "USER_MESSAGE", text: input });
      await runTodos(
        buildTodosRunContext({
          getState: () => stateRef.current,
          dispatch: (action) => dispatchRef.current(action),
          sessionId: conversationIdRef.current,
          permissionManager: getPermissionManagerRef.current(),
          cwd,
          allTools: agentToolsRef.current,
          abortSignal: abortControllerRef.current.signal,
          todosRunExecutors: getTodosRunExecutors(),
          clearInput: () => setInputRef.current(""),
          onConfirmTodoRun: (pending) => {
            confirmedTodoRunRef.current = pending;
            setPendingTodoRunPlan(pending);
          },
          todoRunConfirmed: confirmed,
          todoRunSnapshot: approvedPlan?.todos,
          rawParsedArgs: parsed.args,
        }),
        resolveTodosRunArgs(approvedPlan?.parsed, parsed.args),
      );
      confirmedTodoRunRef.current = undefined;
      dispatchRef.current({ type: "LOOP_EVENT", event: { type: "done", messages: historyRef.current } });
    },
    [cwd, agentToolsRef, getTodosRunExecutors],
  );

  const pendingImagesRef = useRef<ImageAttachment[]>([]);
  pendingImagesRef.current = state.pendingImages;
  const promptQueueRef = useRef<string[]>([]);
  const diffFilesRef = useRef<string[]>([]);
  const [diffFileCandidates, setDiffFileCandidates] = useState<string[]>([]);
  const pendingSubagentPromptsRef = useRef(new Map<string, string[]>());
  const sendNowPendingRef = useRef(false);
  const sendNowWaitToolIdsRef = useRef(new Set<string>());
  const [queuedCount, setQueuedCount] = useState(0);
  // The prompt text lives in an external store instead of component state:
  // a keystroke no longer re-renders the whole AgentSessionApp tree (feed,
  // status bar, overlays). Only the subscribed PromptInput re-renders.
  const inputStore = useLazyRef(() => createInputStore()).current;
  const input = useSyncExternalStore(inputStore.subscribe, inputStore.get, inputStore.get);
  const setInput = useCallback((value: string) => inputStore.set(value), [inputStore]);
  // Bump to remount the text input so ink-text-input resets cursorOffset to value.length
  // after programmatic completions (Tab @file / slash commands).
  const [inputEpoch, setInputEpoch] = useState(0);
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

  // Refs so runTodosCommand (declared above) stays stable.
  const stateRef = useRef(state);
  const dispatchRef = useRef(dispatch);
  const conversationIdRef = useRef(conversationId);
  const setInputRef = useRef(setInput);
  const getPermissionManagerRef = useRef(() => permissionManagerRef.current ?? (permissionManagerRef.current = new PermissionManager("plan")));
  const abortControllerRef = useRef<AbortController>(new AbortController());
  /** Alias for `abortControllerRef` (keeps the long-standing `abortRef` name). */
  const abortRef = abortControllerRef;
  const historyRef = useRef<AgentMessage[]>(createTuiAgentHistory("plan", systemPromptContext));
  const activeTodosRef = useRef(state.todoItems);
  const thinkingPolicyModeRef = useRef(loadThinkingModeFromEnv());
  const sessionProvenanceRef = useRef<Pick<PersistedSession, "parentSessionId" | "forkedFromMessage" | "forkedFromMessageId" | "origin">>({});
  const getPermissionManager = useCallback(() => {
    return permissionManagerRef.current ?? (permissionManagerRef.current = new PermissionManager("plan"));
  }, []);

  // Re-sync refs each render.
  stateRef.current = state;
  activeTodosRef.current = state.todoItems;
  dispatchRef.current = dispatch;
  conversationIdRef.current = conversationId;
  setInputRef.current = setInput;

  // Build the background-sub-agent event router once, after every ref it
  // depends on is declared. The queue arrays/maps and refs are captured by
  // identity (never reassigned as a whole), so the instance stays valid.
  subagentEventRouter.current ??= new SubagentEventRouter({
    conversationId: () => conversationIdRef.current,
    getState: () => stateRef.current,
    dispatch,
    registry: subagentTaskRegistry,
    pendingSubagentPrompts: pendingSubagentPromptsRef.current,
    promptQueue: promptQueueRef.current,
    setQueuedCount,
    submitPrompt: (text) => handleSubmitRef.current(text),
  });
  useEffect(() => {
    if (!goalConfig.enabled) return;
    void getGoalSession()?.manager.get().then((current) => {
      setGoalState(current ? current.snapshot : null);
    }).catch(() => {
      // The workspace may disappear (session switch, test teardown) while the
      // goal store lock is still being acquired; a missing goal is not fatal.
    });
  }, [conversationId, goalConfig.enabled]);

  const smoothScrollRef = useLazyRef(() => new SmoothScrollController({
    getOffset: () => stateRef.current.scrollOffset,
    getMaxOffset: () => stateRef.current.maxScrollOffset,
    scrollTo: (offset) => dispatchRef.current({ type: "SCROLL_TO", offset }),
  }));
  const heightCacheRef = useLazyRef(() => new MessageHeightCache());
  const scrollBackhintShownRef = useRef(false);
  const scrollBy = useCallback((delta: number) => {
    // Inline layout: deep history lives in the terminal's native scrollback,
    // not in the in-app window (which only covers the unsealed tail). Guide
    // the user once when an upward page-up finds nothing left to scroll.
    if (delta > 0 && usesStreamChannel && !scrollBackhintShownRef.current) {
      const current = stateRef.current;
      const max = current.maxScrollOffset ?? 0;
      if (max <= 0 || current.scrollOffset >= max) {
        scrollBackhintShownRef.current = true;
        dispatch({
          type: "ADD_NOTICE",
          title: "Scrolling history",
          text: "Earlier replies live in the terminal's native scrollback — use the mouse wheel, trackpad, or your terminal's scroll-back shortcut. PgUp/PgDn page the live view; Ctrl+G returns to the bottom; Ctrl+L clears the screen.",
        });
      }
    }
    smoothScrollRef.current.scrollBy(delta);
  }, [smoothScrollRef, effectiveLayoutMode, dispatch]);
  const jumpToBottom = useCallback(() => {
    smoothScrollRef.current.jumpTo(0);
  }, [smoothScrollRef]);
  jumpToBottomRef.current = jumpToBottom;
  const previousMaxScrollOffsetRef = useRef(state.maxScrollOffset);
  useLayoutEffect(() => {
    const maxOffsetChanged = previousMaxScrollOffsetRef.current !== state.maxScrollOffset;
    previousMaxScrollOffsetRef.current = state.maxScrollOffset;
    smoothScrollRef.current.sync(state.scrollOffset, maxOffsetChanged);
  }, [smoothScrollRef, state.scrollOffset, state.maxScrollOffset]);
  useEffect(() => () => smoothScrollRef.current.dispose(), [smoothScrollRef]);

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
    if (pendingPermissionRef.current || stateRef.current.pendingModeRequest) return;
    // PromptInput ignores Ctrl/Meta chords, so do not swallow the next character.
    suppressInputEchoRef.current = false;
    setInput(sanitizeInput(value));
  }, []);

  // ── autocomplete hook ────────────────────────────────────────────────────
  const resetInputCursorToEnd = useCallback(() => {
    setInputEpoch((n) => n + 1);
  }, []);

  // ── session list + MCP status for the session overlay ──────────────────────
  const sessionManagerRef = useRef<SessionManager | null>(null);
  const getSessionManager = useCallback(() => {
    if (!sessionManagerRef.current) {
      sessionManagerRef.current = new SessionManager({ workspaceId: projectCwd, sessionId: conversationIdRef.current });
    }
    return sessionManagerRef.current;
  }, [projectCwd]);
  const listSessions = useCallback(() => getSessionManager().list(), [getSessionManager]);
  const getGoalSession = useCallback((): GoalSessionContext | null => {
    if (!goalConfig.enabled) return null;
    if (goalSessionRef.current && goalSessionRef.current.sessionId === conversationIdRef.current) {
      return goalSessionRef.current;
    }
    const session = createGoalSession({
      ...goalConfig,
      sessionId: conversationIdRef.current,
      onEvent: (event) => setGoalState(event.goal),
      steering: {
        onGoalSnapshot: (snapshot) => setGoalState(snapshot),
      },
      // Model-initiated background goals: create_goal(background=true) forks
      // the same detached worktree worker as `/goal ... --bg`.
      launchBackground: async ({ objective }) => {
        const launch = await launchBackgroundGoal({
          cwd: projectCwd,
          ownerSessionId: conversationIdRef.current,
          objective,
          registry: subagentTaskRegistry,
          store: session.store,
          concurrencyLimit: loadGlobalGoalWorkerLimitFromEnv(),
        });
        dispatch({ type: "ADD_NOTICE", title: "Goal", text: backgroundGoalNotice(launch) });
        return launch;
      },
    });
    // Opt-in diagnostics (MINI_AGENT_GOAL_LOG=1). Taps the existing callbacks and
    // wraps the runtime's steering/continuation methods in place, so the session,
    // store, and TUI state updates above are all preserved.
    attachGoalDiagnostics(session, {
      log: createGoalLog(conversationIdRef.current),
      onEvent: (event) => setGoalState(event.goal),
      onGoalSnapshot: (snapshot) => setGoalState(snapshot),
    });
    goalSessionRef.current = session;
    void session.manager.initialize().catch(() => {
      // Initialization races workspace teardown in short-lived sessions; the
      // next goal operation recreates the store on demand.
    });
    return session;
  }, [goalConfig]);

  // Session restore deps are stable refs, so the resume/import helpers can be
  // shared with the headless paths instead of living in this component.
  const sessionRestoreDeps = useMemo<SessionRestoreDeps>(() => ({
    cwd,
    projectCwd,
    agentId,
    dispatch,
    systemPromptContext,
    stateRef,
    llmRef,
    historyRef,
    activeTodosRef,
    localRoleLlmConfigsRef,
    skillNamesRef,
    thinkingPolicyModeRef,
    sessionProvenanceRef,
    getSessionManager,
    getPermissionManager,
    setConversationId,
    setLlm,
    setSkillNames,
    onWorkspaceChange,
  }), [
    agentId,
    cwd,
    dispatch,
    getPermissionManager,
    getSessionManager,
    onWorkspaceChange,
    projectCwd,
    setConversationId,
    setLlm,
    setSkillNames,
    systemPromptContext,
  ]);

  const resumeSession = useCallback(
    (prefix: string, fork = false) => resumeSessionInTui(sessionRestoreDeps, prefix, fork),
    [sessionRestoreDeps],
  );

  const importForeign = useCallback(
    (source: "claude" | "codex", reference: string) =>
      importForeignSessionInTui(sessionRestoreDeps, source, reference),
    [sessionRestoreDeps],
  );

  const startupSessionHandledRef = useRef(false);
  useEffect(() => {
    if (startupSessionHandledRef.current || !startupSessionRequest?.resume) return;
    startupSessionHandledRef.current = true;
    if (!startupSessionRequest.sessionId && !startupSessionRequest.continueSession && !startupSessionRequest.fork) {
      setInput("/resume");
      return;
    }
    void resumeSession(startupSessionRequest.sessionId ?? "", startupSessionRequest.fork);
  }, [resumeSession, startupSessionRequest]);

  const resumeSelectedSession = useCallback((sessionId: string) => {
    void resumeSession(sessionId);
  }, [resumeSession]);

  const sessionSnapshotFields = useCallback((modelOverride?: LlmConfig) => {
    const current = stateRef.current;
    return {
      id: conversationIdRef.current,
      modelId: `${(modelOverride ?? llmRef.current).provider}/${(modelOverride ?? llmRef.current).model}`,
      modelConfig: serializeTuiModelConfig(modelOverride ?? llmRef.current),
      subagentModelConfigs: Object.fromEntries(
        Object.entries(localRoleLlmConfigsRef.current).map(([role, config]) => [role, serializeTuiModelConfig(config)]),
      ),
      thinkingLevel: (modelOverride ?? llmRef.current).thinkingLevel,
      thinkingMode: thinkingPolicyModeRef.current,
      permissionMode: getPermissionManager().getMode(),
      // Persist the unanswered card so a restart does not leave a
      // "Requested a switch" tool result with no way to answer it.
      ...(current.pendingModeRequest ? { pendingModeRequest: current.pendingModeRequest } : {}),
      skillNames: [...skillNamesRef.current],
      phase: current.phase,
      currentPlan: current.currentPlan,
      todos: toPersistedTodos(activeTodosRef.current),
      todoVersion: current.todoRevision,
      cwd,
      ...sessionProvenanceRef.current,
    };
  }, [cwd, getPermissionManager]);

  /** Cap persisted message count to keep session files bounded on very long sessions. */
  const MAX_PERSISTED_MESSAGES = 2_000;
  /** In-memory history cap: keep the conversation productive without letting the
   *  raw AgentMessage array grow past what two context windows would hold. */
  const MAX_IN_MEMORY_MESSAGES = 2_500;

  const persistSessionSnapshot = useCallback(async (messages: AgentMessage[], modelConfig?: LlmConfig) => {
    try {
      // Trim in-memory history to bound peak allocation between compaction cycles.
      const inMemory = messages.length > MAX_IN_MEMORY_MESSAGES
        ? messages.slice(-MAX_IN_MEMORY_MESSAGES)
        : messages;
      // Write a bounded snapshot to disk.
      const trimmed = inMemory.length > MAX_PERSISTED_MESSAGES
        ? inMemory.slice(-MAX_PERSISTED_MESSAGES)
        : inMemory;
      await getSessionManager().save({ ...sessionSnapshotFields(modelConfig), messages: trimmed });
    } catch (error) {
      dispatch({
        type: "ADD_NOTICE",
        title: "Session save failed",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  }, [dispatch, getSessionManager, sessionSnapshotFields]);

  const [mcpStatus, setMcpStatus] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!mcpStatuses) return;
    const refresh = () => {
      try {
        setMcpStatus(formatMcpStatus(mcpStatuses()));
      } catch {
        setMcpStatus(undefined);
      }
    };
    refresh();
    // Faster cadence while any server is still connecting: with deferred MCP
    // startup the status bar flips from "connecting" to ready/error soon after
    // the first frame, and a 5s wait feels broken for that transition.
    const timer = setInterval(() => {
      refresh();
      const stillConnecting = mcpStatuses().some((status) => status.state === "connecting");
      if (!stillConnecting) clearInterval(timer);
    }, 500);
    const settleTimer = setTimeout(() => clearInterval(timer), 30_000);
    return () => {
      clearInterval(timer);
      clearTimeout(settleTimer);
    };
  }, [mcpStatuses]);

  // Required-MCP failure after deferred startup: show a notice in the live UI
  // (never a silent black-screen abort) and exit nonzero after the user sees it.
  useEffect(() => {
    if (!mcpFailure) return;
    let cancelled = false;
    void mcpFailure.promise.then((failure) => {
      if (cancelled || !failure) return;
      dispatch({
        type: "ADD_NOTICE",
        title: "MCP unavailable",
        text: `${failure.message}\nRequired MCP servers must start before the session can run. Fix MINI_AGENT_MCP_CONFIG or mark the server optional, then restart.`,
      });
      exit();
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [mcpFailure, dispatch, exit]);

  const {
    acMode,
    setAcMode,
    acIndex,
    setAcIndex,
    cmdCandidates,
    fileCandidates,
    modelCandidates,
    configuredModelCandidates,
    modelPickerSection,
    sessionCandidates,
    sessionCommand,
    sessionLoading,
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
    handleTabAt,
    handleAutocompleteKey,
    openModelPicker,
  } = useAutocomplete({
    input,
    cwd,
    setInput,
    resetInputCursorToEnd,
    listSessions,
    onResumeSession: resumeSelectedSession,
  });

  // Read live acMode inside callbacks whose dependency arrays omit acMode (notably
  // handleSubmit). Prevents stale `null` values that skip picker-scoped behavior.
  const acModeRef = useRef<AcMode>(acMode);
  acModeRef.current = acMode;
  // Same for the model-setup form state, which the handleSubmit form-flow
  // branches (Base URL → API key → effort) read.
  const modelSetupRef = useRef(modelSetup);
  modelSetupRef.current = modelSetup;
  // The model-picker section (configured vs catalog) decides whether catalog
  // selections must re-enter the API key. handleSubmit omits it from its
  // dependency array, so read the live value from a ref here.
  const modelPickerSectionRef = useRef(modelPickerSection);
  modelPickerSectionRef.current = modelPickerSection;

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

  /**
   * Apply or dismiss the model's permission-mode request.
   *
   * Accepting calls `PermissionManager.setMode`, which aborts the in-flight
   * turn with `PermissionModeChangedError` (turns must never straddle two
   * policies). The model is instructed to end its turn right after asking, so
   * the normal path is: card appears, turn finishes, user presses A, the mode
   * changes and a follow-up prompt resumes the task.
   *
   * If the user presses A while the turn is still streaming, the switch is
   * deferred to the moment the turn ends (`autoSwitchModeRef`); switching now
   * would abort the turn and its late `aborted` event would clobber the
   * follow-up turn.
   */
  const autoSwitchModeRef = useRef(false);
  const applyModeRequest = useCallback((mode: PermissionMode, reason?: string) => {
    const manager = getPermissionManager();
    if (manager.getMode() !== mode) {
      // `model_request` keeps the audit trail honest: the model asked, the
      // human confirmed, and the manager is the only thing that changed state.
      manager.setMode(mode, "model_request", reason);
      if (historyRef.current.length > 0) applyPermissionModePrompt(historyRef.current, mode);
    }
    dispatch({ type: "SET_PERMISSION_MODE", mode });
    dispatch({ type: "CLEAR_MODE_REQUEST" });
    dispatch({
      type: "ADD_NOTICE",
      title: "Permission mode",
      text: `Switched to ${modeRequestLabel(mode)}. Continuing the task.`,
    });
    // Resume through the prompt queue instead of calling handleSubmit here:
    // clearing the card wakes the queue drain in the same commit, and two
    // independent submits would race into two overlapping turns. Unshift so
    // the resume runs before any completion prompt that arrived while the
    // card was waiting.
    promptQueueRef.current.unshift(modeRequestContinuationPrompt(mode));
    setQueuedCount(promptQueueRef.current.length);
  }, [dispatch, getPermissionManager]);

  const resolveModeRequest = useCallback((decision: "switch" | "dismiss") => {
    const pending = stateRef.current.pendingModeRequest;
    if (!pending) return;
    if (decision === "dismiss") {
      autoSwitchModeRef.current = false;
      dispatch({ type: "CLEAR_MODE_REQUEST" });
      dispatch({ type: "ADD_NOTICE", title: "Mode request dismissed", text: `Staying in ${stateRef.current.permissionMode} mode.` });
      return;
    }
    if (stateRef.current.busy) {
      autoSwitchModeRef.current = true;
      dispatch({
        type: "ADD_NOTICE",
        title: "Mode switch queued",
        text: `Will switch to ${modeRequestLabel(pending.mode)} as soon as the current turn finishes.`,
      });
      return;
    }
    applyModeRequest(pending.mode, pending.reason);
  }, [applyModeRequest, dispatch]);

  // Deferred switch: the user accepted while the turn was still streaming.
  useEffect(() => {
    if (!autoSwitchModeRef.current || state.busy) return;
    const pending = state.pendingModeRequest;
    autoSwitchModeRef.current = false;
    if (!pending) return;
    applyModeRequest(pending.mode, pending.reason);
  }, [state.busy, state.pendingModeRequest, applyModeRequest]);

  useEffect(() => {
    void discoverWorkspaceSkills(cwd).catch(() => { /* non-fatal */ });
  }, [cwd]);

  useEffect(() => {
    void loadPlanDocument(cwd)
      .then((plan) => dispatch({ type: "SET_TODO_PLAN", plan: plan ?? undefined }))
      .catch(() => { /* a missing or unreadable plan is non-fatal */ });
  }, [cwd]);

  // ── model switching ─────────────────────────────────────────────────────

  const selectModelRef = useCallback((reference: string, overrides: ModelSwitchOverrides = {}, options?: ModelSelectOptions) => {
    return selectModel(reference, overrides, {
      openModelPicker,
      openProfileList: (profileNames) => {
        void openProfileList({ llm, setLlm, setModelSetup, setAcMode, setInput, setAcIndex, setProfileListState, dispatch, historyRef }, profileNames);
      },
      activateSavedProfile: (profileName) => {
        void activateSavedModelProfile(profileName, {
          llm, setLlm, setModelSetup, setAcMode, setInput, setAcIndex, setProfileListState, dispatch, historyRef,
          persistSession: persistSessionSnapshot,
        }).catch((error) => {
          dispatch({
            type: "ADD_NOTICE",
            title: "Model profile activation failed",
            text: error instanceof Error ? error.message : String(error),
          });
        });
      },
      commitModelSetup: (setup, apiKey) => commitModelSetup(setup, apiKey, {
        llm, setLlm, setModelSetup, setAcMode, setInput, setAcIndex, setProfileListState, dispatch, historyRef,
        persistSession: persistSessionSnapshot,
      }),
      startModelSetup: (model, modelOverrides, setupOptions) => startModelSetup(model, modelOverrides, {
        llm, setLlm, setModelSetup, setAcMode, setInput, setAcIndex, setProfileListState, dispatch, historyRef,
        persistSession: persistSessionSnapshot,
      }, setupOptions),
    });
  }, [llm, setLlm, setModelSetup, setAcMode, setInput, setAcIndex, setProfileListState, dispatch, historyRef, persistSessionSnapshot]);

  const openProfileListRef = useCallback(async (profileNames?: string[]) => {
    return openProfileList({ llm, setLlm, setModelSetup, setAcMode, setInput, setAcIndex, setProfileListState, dispatch, historyRef }, profileNames);
  }, [llm, setLlm, setModelSetup, setAcMode, setInput, setAcIndex, setProfileListState, dispatch, historyRef]);

  const activateConfiguredProfileRef = useCallback((profileName: string) => {
    void activateSavedModelProfile(profileName, {
      llm, setLlm, setModelSetup, setAcMode, setInput, setAcIndex, setProfileListState, dispatch, historyRef,
      persistSession: persistSessionSnapshot,
    }).catch((error) => {
      dispatch({
        type: "ADD_NOTICE",
        title: "Model profile activation failed",
        text: error instanceof Error ? error.message : String(error),
      });
    });
  }, [llm, setLlm, setModelSetup, setAcMode, setInput, setAcIndex, setProfileListState, dispatch, historyRef, persistSessionSnapshot]);

  // Match Codex's direct effort controls: the active model stays fixed and
  // only the next supported reasoning level is applied for subsequent turns.
  const adjustThinkingLevel = useCallback((direction: "increase" | "decrease", wrap = false) => {
    if (state.busy || state.pendingPermission) return;
    const current = llmRef.current;
    const nextLevel = cycleThinkingLevel(current, direction, { wrap });
    const next = withThinkingLevel(current, nextLevel);
    llmRef.current = next;
    setLlm(next);
    dispatch({ type: "SET_STATUS", status: `Thinking level: ${thinkingLevelToDisplay(nextLevel)}` });
  }, [state.busy, state.pendingPermission]);

  // ── Antigravity-style Effort slider (/effort) ────────────────────────────
  // Levels reflect the model being configured during /model setup; otherwise
  // the active model. An empty choices list falls back to ["medium"] upstream.
  const effortLevels = useMemo(() => {
    if (acMode === "effort-picker" && modelSetup?.field === "effort") {
      return getThinkingLevelChoicesForModel(modelSetup.model);
    }
    return getThinkingLevelChoices(llmRef.current);
  }, [acMode, modelSetup]);
  const [effortPreviewLevel, setEffortPreviewLevel] = useState<ModelThinkingLevel | undefined>(undefined);
  const effortSelectedIndex = useMemo(() => {
    const levels = effortLevels;
    const current = llmRef.current.thinkingLevel ?? (llmRef.current.reasoning ? "medium" : "off");
    const idx = levels.indexOf(current);
    return idx >= 0 ? idx : Math.max(0, levels.length - 1);
  }, [effortLevels, acMode, llm]);
  const openEffortPicker = useCallback(() => {
    setEffortPreviewLevel(undefined);
    clearAc();
    setAcMode("effort-picker");
  }, [clearAc, setAcMode]);
  const handleEffortPreview = useCallback((level: ModelThinkingLevel) => {
    setEffortPreviewLevel(level);
  }, []);
  const handleEffortConfirm = useCallback((level: ModelThinkingLevel) => {
    // Inside the /model setup flow: apply the chosen level, then finish the
    // pending Base URL / API key setup with that level baked into the profile.
    if (modelSetup?.field === "effort") {
      setEffortPreviewLevel(undefined);
      setAcMode("model-setup");
      void commitModelSetup(modelSetup, modelSetup.apiKey, {
        llm, setLlm, setModelSetup, setAcMode, setInput, setAcIndex, setProfileListState, dispatch, historyRef,
        persistSession: persistSessionSnapshot,
      }, { thinkingLevel: level });
      return;
    }
    const current = llmRef.current;
    const next = withThinkingLevel(current, level);
    llmRef.current = next;
    setLlm(next);
    dispatch({ type: "SET_STATUS", status: `Thinking level: ${thinkingLevelToDisplay(level)}` });
    setEffortPreviewLevel(undefined);
    setAcMode(null);
  }, [dispatch, setLlm, setAcMode, llm, setAcIndex, setProfileListState, setModelSetup, setInput, historyRef, modelSetup]);
  const handleEffortCancel = useCallback(() => {
    // Inside the /model setup flow: Esc skips level selection and finishes the
    // setup unchanged (model default thinking level applies).
    if (modelSetup?.field === "effort") {
      setEffortPreviewLevel(undefined);
      setAcMode("model-setup");
      void commitModelSetup(modelSetup, modelSetup.apiKey, {
        llm, setLlm, setModelSetup, setAcMode, setInput, setAcIndex, setProfileListState, dispatch, historyRef,
        persistSession: persistSessionSnapshot,
      });
      return;
    }
    setEffortPreviewLevel(undefined);
    setAcMode(null);
  }, [setAcMode, llm, setAcIndex, setProfileListState, setModelSetup, setInput, historyRef, modelSetup]);

  const {
    showWelcome,
    promptPlaceholder,
    promptRows,
    permissionRows,
    planApprovalRows,
    todoRows,
    pickerLayout,
    feedHeight,
  } = useSessionLayout({
    state,
    acMode,
    modelSetup,
    modelPickerSection,
    cmdCandidateCount: cmdCandidates.length,
    fileCandidateCount: fileCandidates.length,
    modelCandidateCount: modelCandidates.length,
    configuredModelCandidateCount: configuredModelCandidates.length,
    profileListState,
    input,
    pendingTodoRunPlan: Boolean(pendingTodoRunPlan),
    queuedCount,
    foregroundCommandWaiting,
    sendableWaitWaiting,
    termWidth,
    termRows: terminalSize.rows,
    isDocumentLayout,
    hasInputBorder: useClaudeStyleInputBorder,
  });

  // Pinned bottom chrome of the dynamic frame: approval cards, the todo
  // panel, pending images, the input container (prompt rows + optional
  // border), and the bordered status bar. The renderer keeps safe streaming
  // bursts from blanking or re-emitting these rows, so the input box does
  // not flicker while LLM lines commit one by one.
  const pinnedChromeRows =
    permissionRows +
    planApprovalRows +
    todoRows +
    state.pendingImages.length +
    promptRows +
    (useClaudeStyleInputBorder ? 2 : 0) +
    3; // bordered status bar
  useLayoutEffect(() => {
    if (!active) return;
    setPinnedRows?.(pinnedChromeRows);
  }, [active, pinnedChromeRows, setPinnedRows]);

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
      dispatch({ type: "ADD_NOTICE", title: "Clipboard", text: "There is no transcript to copy. Use /copy last, /copy tool, or focus a message first." });
      return;
    }
    const result = await writeClipboardText(selection.text);
    dispatch({
      type: "ADD_NOTICE",
      title: result.ok ? "Copied to clipboard" : "Copy failed",
      text: result.ok
        ? formatCopyResultNotice(selection, result.method)
        : (result.error ?? "Unable to write to the system clipboard"),
    });
  }, [input, state.focusedMessageIndex, state.messages, state.streamingReasoning, state.streamingText]);

  // ── Todo run plan confirmation ────────────────────────────────────────────
  useInput((input, key) => {
    const pending = pendingTodoRunPlan;
    if (!pending) return;
    if (input.toLowerCase() === "a" || key.return) {
      setPendingTodoRunPlan(undefined);
      void runTodosCommand(pending.parsed.raw, {
        cmd: "todos-run",
        args: { ...pending.parsed, dryRun: false, confirm: true },
      });
      return;
    }
    if (key.escape || input.toLowerCase() === "d") {
      setPendingTodoRunPlan(undefined);
      dispatch({ type: "ADD_NOTICE", title: "Todo runner", text: "Run cancelled." });
    }
  }, { isActive: active && Boolean(pendingTodoRunPlan) });

  // ── keyboard handler ─────────────────────────────────────────────────────

  useKeyboardHandler({
    exit, abortRef, copyResolvedText, pasteImage: handlePasteImageRef, getPermissionManager,
    adjustThinkingLevel, resolvePendingPermission, resolveModeRequest, dispatch, scrollBy, jumpToBottom,
    clearScreen: requestClearScreen,
    acMode, state, feedHeight, handleAutocompleteKey, historyRef,
    suppressInputEchoRef, pendingPermissionRef,
    bgPanelOpen, onCloseBgPanel: () => setBgPanelOpen(false),
    backgroundForegroundTask: async () => getBgManager()?.backgroundForegroundTask(),
    dashboardOpen, onCloseDashboard, onOpenDashboard,
    tasksPaneOpen, onCloseTasksPane: () => setTasksPaneOpen(false),
    isActive: active,
  });

  // ── direct tool invocation ────────────────────────────────────────────────

  const runDirectToolRef = useCallback(async (toolName: string, args: Record<string, unknown>) => {
    return runDirectTool(toolName, args, {
      allTools: allToolsRef.current,
      permissionSessionId,
      getPermissionManager,
      abortSignal: abortRef.current.signal,
      dispatch,
      runtimeContext: { sessionId: conversationId, workspaceId: projectCwd, cwd },
    });
  }, [getPermissionManager, abortRef, conversationId, dispatch, cwd, projectCwd]);

  // ── @file resolver ────────────────────────────────────────────────────────

  const resolveAtRefsRef = useCallback(async (text: string, permissionTurn: PermissionTurnContext): Promise<MessageContent> => {
    return resolveAtRefs(text, permissionTurn, allToolsRef.current, undefined, { sessionId: conversationId, workspaceId: projectCwd, cwd });
  }, [allToolsRef, conversationId, cwd, projectCwd]);

  // ── submit handler ────────────────────────────────────────────────────────

  const sendNowWhileBusy = useCallback((text?: string): boolean => {
    if (!stateRef.current.busy) return false;
    const trimmed = text?.trim() ?? "";
    if (sendNowPendingRef.current) {
      if (trimmed) promptQueueRef.current.push(trimmed);
      setQueuedCount(promptQueueRef.current.length);
      setInput("");
      return true;
    }
    if (trimmed) promptQueueRef.current.unshift(trimmed);
    else if (promptQueueRef.current.length === 0) return false;

    setQueuedCount(promptQueueRef.current.length);
    setInput("");
    const activeController = abortRef.current;
    const manager = getBgManager();
    if (manager?.isForegroundWaiting()) {
      sendNowPendingRef.current = true;
      void manager.backgroundForegroundTask().then((taskId) => {
        sendNowPendingRef.current = false;
        if (!taskId) return;
        dispatch({
          type: "ADD_NOTICE",
          title: "Sending now",
          text: `The waiting command moved to the background (${taskId}). Starting your message.`,
        });
        activeController.abort("send_now");
      }).catch((error) => {
        sendNowPendingRef.current = false;
        dispatch({
          type: "ADD_NOTICE",
          title: "Message queued",
          text: error instanceof Error ? error.message : String(error),
        });
      });
      return true;
    }

    activeController.abort("send_now");
    return true;
  }, [getBgManager]);

  // Slash-command dispatch context. Rebuilt per render so the cascade always
  // sees the live callbacks; `handleSubmit` reads it at submit time.
  const commandCascadeContext: CommandCascadeContext = {
    cwd,
    state,
    dispatch,
    setInput,
    llm,
    llmRef,
    historyRef,
    activeTodosRef,
    localRoleLlmConfigsRef,
    pendingImagesRef,
    skillNamesRef,
    thinkingPolicyModeRef,
    sessionProvenanceRef,
    planCaptureRef,
    execCaptureRef,
    diffFilesRef,
    resizeRefreshRef,
    sessionManagerRef,
    acModeRef,
    modelPickerSectionRef,
    allToolsRef,
    ...(mcpStatuses ? { mcpStatuses } : {}),
    ...(mcpTools ? { mcpTools } : {}),
    modelContextWindows,
    systemPromptContext,
    getBgManager,
    getPermissionManager,
    getSessionManager,
    refreshBgTaskCount,
    persistSessionSnapshot,
    resumeSession,
    importForeign,
    copyResolvedText,
    addPendingImageRef,
    handlePasteImageRef,
    runDirectToolRef,
    runTodosCommand,
    selectModelRef,
    openProfileListRef,
    openModelPicker,
    openEffortPicker,
    handleEffortConfirm,
    setSkillNames,
    setConversationId,
    setAcMode,
    setAcIndex,
    setBgPanelOpen,
    setTasksPaneOpen,
    setThemeDialogOpen,
    setDiffFileCandidates,
    exit,
  };

  // `handleSubmit` is intentionally identity-stable (the queue and startup
  // effects depend on it), so it reads the dispatch context through a ref
  // instead of capturing a per-render object.
  const commandCascadeContextRef = useRef(commandCascadeContext);
  commandCascadeContextRef.current = commandCascadeContext;

  const handleSubmit = useCallback(async (text: string) => {
    const trimmed = text.trim();
    const goalCommand = parseGoalCommand(trimmed);
    // `/goal <objective>` registers the goal AND immediately starts a real
    // agent turn with the objective as the prompt (previously it only set
    // state and waited for the next message). Pure management subcommands
    // (status/clear/pause/resume/complete) keep their notice-only behavior.
    let goalKickoffPrompt: string | undefined;
    const allowEmptyApiKey =
      acModeRef.current === "model-setup" && modelSetupRef.current?.field === "apiKey";
    const hasPendingImages = pendingImagesRef.current.length > 0;
    if (state.busy && !trimmed && promptQueueRef.current.length > 0) {
      sendNowWhileBusy();
      return;
    }
    if (!trimmed && !allowEmptyApiKey && !hasPendingImages) return;
    jumpToBottom();
    if (trimmed === "/dashboard") {
      onOpenDashboard();
      setAcMode(null);
      setInput("");
      return;
    }
    if (goalCommand) {
      setInput("");
      if (!goalConfig.enabled) {
        dispatch({ type: "ADD_NOTICE", title: "Goals", text: "Goals are disabled by MINI_AGENT_GOALS=0. Remove that override to enable them." });
        return;
      }
      const goalSession = getGoalSession();
      if (!goalSession) return;
      if (goalCommand.kind === "invalid") {
        dispatch({ type: "ADD_NOTICE", title: "Goal", text: goalCommand.message });
        return;
      }
      try {
        if (goalCommand.kind === "status") {
          const current = await goalSession.manager.get();
          dispatch({ type: "ADD_NOTICE", title: "Goal", text: goalNotice(current?.raw) });
          return;
        }
        const updated = goalCommand.kind === "clear"
          ? await goalSession.manager.setFromUser({ clear: true })
          : goalCommand.kind === "set"
            ? await goalSession.manager.setFromUser({
                objective: goalCommand.objective,
                ...(goalCommand.tokenBudget !== undefined ? { tokenBudget: goalCommand.tokenBudget } : {}),
              })
            : await goalSession.manager.setFromUser({ status: goalCommand.status });
        dispatch({ type: "ADD_NOTICE", title: "Goal", text: goalNotice(updated) });
        // `--bg`: hand the goal to a detached worker in an isolated worktree
        // (bypass permissions). The foreground stays free; the mutex above
        // keeps this session's loop from double-steering the same goal.
        if (goalCommand.kind === "set" && goalCommand.background && updated) {
          try {
            const launch = await launchBackgroundGoal({
              cwd: projectCwd,
              ownerSessionId: conversationIdRef.current,
              objective: goalCommand.objective,
              registry: subagentTaskRegistry,
              store: goalSession.store,
              concurrencyLimit: loadGlobalGoalWorkerLimitFromEnv(),
            });
            dispatch({ type: "ADD_NOTICE", title: "Goal", text: backgroundGoalNotice(launch) });
          } catch (error) {
            dispatch({ type: "ADD_NOTICE", title: "Goal", text: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        // Kick off execution right away: re-enter the submission path with the
        // objective as a plain user prompt. `setFromUser` has already armed the
        // "created"/"edited" steering intent, so the first model call sees the
        // goal context and goalRuntime drives automatic continuations.
        //
        // Guard against self-reference: an objective like "goal fix the bug"
        // would parse as another /goal command and recurse forever. The bare
        // word "goal" only counts as a command at the start, so prefixing
        // "Work on:" (or any non-command word) neutralizes it while keeping
        // the objective text intact for the model.
        if (goalCommand.kind === "set" && updated) {
          goalKickoffPrompt = parseGoalCommand(goalCommand.objective)
            ? `Work on: ${goalCommand.objective}`
            : goalCommand.objective;
        }
      } catch (error) {
        dispatch({ type: "ADD_NOTICE", title: "Goal", text: error instanceof Error ? error.message : String(error) });
      }
      if (goalKickoffPrompt === undefined) return;
    }
    if (state.busy) {
      // Busy + explicit `/goal <objective>`: the goal is already registered
      // (the branch above ran setFromUser). Queue the objective as a normal
      // prompt so it executes when the current turn ends, with goal steering
      // attached, instead of aborting or overlapping the in-flight turn.
      if (goalKickoffPrompt !== undefined) {
        promptQueueRef.current.push(goalKickoffPrompt);
        setQueuedCount(promptQueueRef.current.length);
        dispatch({ type: "ADD_NOTICE", title: "Goal", text: "A turn is already running; the goal objective was queued and will start when it finishes." });
        setInput("");
        return;
      }
      if (trimmed) {
        const sendableWait = foregroundCommandWaiting || sendableWaitWaiting;
        if (sendableWait && promptQueueRef.current.length === 0 && !sendNowPendingRef.current) {
          sendNowWhileBusy(trimmed);
          return;
        }
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
          const previousLlm = llmRef.current;
          const newLlm = loadLlmConfigFromEnv();
          llmRef.current = newLlm;
          setLlm(newLlm);
          dispatch({ type: "MODEL_CHANGED", modelName: newLlm.model });
          // Adapt existing conversation history for the new model's capabilities
          if (historyRef.current.length > 1) {
            historyRef.current = adaptHistoryForModel(historyRef.current, {
              targetCapabilities: newLlm.capabilities,
              sourceCapabilities: previousLlm.capabilities,
            });
          }
          await persistSessionSnapshot(historyRef.current, newLlm);
        } catch { /* non-fatal */ }
      }
      setInput("");
      clearAc();
      return;
    }

    if (acModeRef.current === "model-setup" && modelSetupRef.current) {
      const activeModelSetup = modelSetupRef.current;
      const deletion = resolveModelDeleteConfirmation(activeModelSetup, trimmed);
      if (deletion.action === "confirm") {
        const resumeField = activeModelSetup.field === "apiKey" ? "apiKey" : "baseUrl";
        setModelSetup({ ...activeModelSetup, field: "deleteConfirm", resumeField, error: undefined });
        setInput("");
        return;
      }
      if (deletion.action === "cancel") {
        const resumeField = activeModelSetup.resumeField ?? "baseUrl";
        setModelSetup({ ...activeModelSetup, field: resumeField, error: undefined });
        setInput(resumeField === "apiKey" ? activeModelSetup.apiKey : "");
        return;
      }
      if (deletion.action === "delete") {
        try {
          const { profileName } = await deleteConfiguredModelProfile(activeModelSetup);
          const wasActive = `${llmRef.current.provider}/${llmRef.current.model}` === `${activeModelSetup.model.provider}/${activeModelSetup.model.id}`;
          if (wasActive) {
            const nextLlm = loadLlmConfigFromEnv();
            llmRef.current = nextLlm;
            setLlm(nextLlm);
            dispatch({ type: "MODEL_CHANGED", modelName: nextLlm.model });
            await persistSessionSnapshot(historyRef.current, nextLlm);
          }
          dispatch({
            type: "ADD_NOTICE",
            title: "Model",
            text: `Profile "${profileName}" deleted.`,
          });
          setModelSetup(undefined);
          setInput("");
          setAcMode(null);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const missing = /does not exist/i.test(message);
          setModelSetup({
            ...activeModelSetup,
            field: missing ? (activeModelSetup.resumeField ?? "baseUrl") : "deleteConfirm",
            error: missing ? "No saved profile to delete." : message,
          });
          setInput("");
        }
        return;
      }
      if (activeModelSetup.field === "deleteConfirm") return;
      if (activeModelSetup.field === "baseUrl") {
        const baseUrl = trimmed.replace(/\/$/, "");
        setModelSetup({ ...activeModelSetup, baseUrl, field: "apiKey", error: undefined });
        setInput(activeModelSetup.apiKey);
      } else {
        // API key captured: move to the Antigravity-style Effort step so the
        // user picks the reasoning level before the model activates. Enter on
        // the slider commits with the chosen level; Esc commits unchanged.
        setModelSetup({ ...activeModelSetup, apiKey: trimmed, field: "effort", error: undefined });
        setInput("");
        setAcMode("effort-picker");
      }
      return;
    }

    clearAc();

    // Goal kickoff: re-enter the normal submission path with the objective as
    // a plain prompt. The goal is already registered and its "created"
    // steering intent armed, so this turn injects goal context and the
    // goalRuntime drives automatic continuations. Recursion terminates: the
    // objective is plain text, so parseGoalCommand returns undefined.
    if (goalKickoffPrompt !== undefined) {
      return handleSubmitRef.current(goalKickoffPrompt);
    }

    const cascade = await runCommandCascade(commandCascadeContextRef.current, trimmed);
    if (cascade.handled) return;
    const planTurnOverride = cascade.planTurnOverride;

    const pendingImgs = planTurnOverride ? [] : [...pendingImagesRef.current];
    if (!planTurnOverride && !trimmed && pendingImgs.length === 0) {
      setInput("");
      return;
    }
    await runSessionTurn({
      trimmed,
      planTurnOverride,
      cwd,
      projectCwd,
      conversationId,
      state,
      dispatch,
      setInput,
      llm,
      llmRef,
      setLlm,
      historyRef,
      activeTodosRef,
      pendingImagesRef,
      skillNamesRef,
      thinkingPolicyModeRef,
      planCaptureRef,
      execCaptureRef,
      permissionTurnRef,
      abortRef,
      streamBufferRef,
      stateRef,
      sendNowWaitToolIdsRef,
      agentToolsRef,
      subagentRuntimeRef,
      subagentTaskRegistry,
      autoSubagent,
      vision,
      globalTokenBudget,
      goalConfig,
      getGoalSession,
      getPermissionManager,
      getSessionManager,
      refreshBgTaskCount,
      persistSessionSnapshot,
      resolveAtRefsRef,
      setSendableWaitWaiting,
      permissionSessionId,
      maxInMemoryMessages: MAX_IN_MEMORY_MESSAGES,
      defaultImagePrompt: DEFAULT_IMAGE_PROMPT,
      getSubagentTools,
      sessionSnapshotFields,
    });
  }, [state, llm, vision, resolveAtRefsRef, clearAc, getPermissionManager, conversationId, cwd, projectCwd, globalTokenBudget, refreshBgTaskCount, sessionSnapshotFields, getSessionManager, persistSessionSnapshot, jumpToBottom, onOpenDashboard, foregroundCommandWaiting, sendableWaitWaiting, sendNowWhileBusy]);

  handleSubmitRef.current = handleSubmit;

  useBackgroundWakeups({
    active,
    conversationId,
    dispatch,
    stateRef,
    getBgManager,
    refreshBgTaskCount,
    subagentTaskRegistry,
    promptQueueRef,
    pendingSubagentPromptsRef,
    setQueuedCount,
    handleSubmit,
    handleSubmitRef,
    busy: state.busy,
    pendingPermission: Boolean(state.pendingPermission),
    pendingModeRequest: Boolean(state.pendingModeRequest),
    planPhase: state.phase,
    planStatus: state.currentPlan?.status,
  });


  const initialPromptStartedRef = useRef(false);
  useEffect(() => {
    if (!initialPrompt || initialPromptStartedRef.current) return;
    initialPromptStartedRef.current = true;
    void handleSubmit(initialPrompt);
  }, [handleSubmit, initialPrompt]);

  // ── render ────────────────────────────────────────────────────────────────

  // Inline layout: transcript messages that reached their final form are
  // emitted once into the terminal's native scrollback through the renderer's
  // static-burst channel; the dynamic frame only renders the unsealed tail
  // (running tools, subagent cards, streaming text) plus chrome.
  const {
    sealedStatic,
    streamSealPendingIndex,
    sealedPendingAssistantRows,
    committedPendingAssistantTexts,
    committedStreamingRows,
  } = useStreamBursts({
    state,
    dispatchRef,
    usesStreamChannel,
    isDocumentLayout,
    ...(writeStaticBurst ? { writeStaticBurst } : {}),
    termWidth,
    termHeight,
    cwd,
    active,
    heightCache: heightCacheRef.current,
    resizeRefreshRef,
  });

  const viewportContentHeight = estimateViewportContentHeight({
    messages: state.messages,
    streamingText: state.streamingText,
    streamingReasoning: state.streamingReasoning,
    busy: state.busy,
    thinkingMode: state.thinkingMode,
    expandedThinking: state.expandedThinking,
    width: termWidth,
    // Sealed rows live in the terminal's native scrollback (inline mode);
    // scroll accounting covers only the dynamic frame's transcript.
    historyStartIndex: sealedStatic.sealedCount,
    documentMode: isDocumentLayout,
    committedStreamingRows,
    sealedAssistantRows: sealedPendingAssistantRows,
    committedAssistantTexts: committedPendingAssistantTexts,
    streamSealPendingIndex,
    // Estimate against the FULL canonical transcript (no 500 cap) so the scroll
    // offset/scrollback math covers the entire history the user can page back
    // through, matching Antigravity-style scrolling.
    maxMessages: Number.MAX_SAFE_INTEGER,
    cache: heightCacheRef.current,
  });
  const handleScrollContext = useCallback((direction: "up" | "down") => {
    // PageUp/PageDown are owned by useKeyboardHandler so one keypress moves
    // exactly one viewport; this path only handles arrow-key line scrolling.
    scrollBy(direction === "up" ? 3 : -3);
  }, [scrollBy]);
  useLayoutEffect(() => {
    dispatch({
      type: "SET_MAX_SCROLL_OFFSET",
      offset: Math.max(0, viewportContentHeight - Math.max(1, Math.max(3, feedHeight) - 1)),
    });
  }, [dispatch, viewportContentHeight, feedHeight]);
  const previousViewportHeightRef = useRef(viewportContentHeight);
  useLayoutEffect(() => {
    const previous = previousViewportHeightRef.current;
    previousViewportHeightRef.current = viewportContentHeight;
    // The max-offset effect above runs first, so this compensation is not
    // clamped against the previous (smaller) scrollback range.
    if (state.scrollOffset > 0 && viewportContentHeight > previous) {
      dispatch({ type: "SCROLL_BY", delta: viewportContentHeight - previous });
    }
  }, [dispatch, viewportContentHeight, state.scrollOffset]);

  useEffect(() => {
    const status = state.pendingPermission || state.pendingModeRequest ? "Needs input"
      : state.busy ? "Working"
        : state.taskStatus === "failed" ? "Failed"
          : state.taskStatus === "cancelled" ? "Cancelled"
            : state.taskStatus === "paused" ? "Paused"
              : state.taskStatus === "completed" ? (state.goal ? "Completed" : "Idle")
                : "Idle";
    onSnapshot({
      id: agentId,
      task: state.taskTitle || state.goal || "No request submitted",
      status,
      activity: state.activeToolId
        ? state.toolById[state.activeToolId]?.name ?? state.status
        : state.status,
      active: state.busy || Boolean(state.pendingPermission) || Boolean(state.pendingModeRequest),
      failed: state.taskStatus === "failed",
      startedAt: state.taskStartedAt,
      workspace: cwd,
    });
  }, [agentId, cwd, onSnapshot, state]);

  if (!active || dashboardOpen) return null;

  return (
    <Box flexDirection="column" width={termWidth} height={isDocumentLayout ? undefined : termHeight} overflow="hidden">
      {/* Inline layout emits sealed transcript blocks directly through the
          renderer's static-burst channel (see writeStaticBurst); the dynamic
          frame never re-renders them. Document layout additionally streams
          the header once, so nothing above the tail is pinned. */}
      {isDocumentLayout ? null : <Header modelName={state.modelName} cwd={cwd} showWelcome={showWelcome} dashboardOpen={dashboardOpen} />}

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
          spinnerMessage={state.spinnerMessage}
          todoPanelVisible={todoRows > 0}
          subagentById={state.subagentById}
          subagentRevision={state.subagentRevision}
          subagentChange={state.subagentChange}
          toolById={state.toolById}
          toolRevision={state.toolRevision}
          toolChange={state.toolChange}
          activeToolId={state.activeToolId}
          availableHeight={feedHeight}
          width={termWidth}
          scrollOffset={state.scrollOffset}
          historyStartIndex={sealedStatic.sealedCount}
          documentMode={isDocumentLayout}
          committedStreamingRows={committedStreamingRows}
          sealedAssistantRows={sealedPendingAssistantRows}
          committedAssistantTexts={committedPendingAssistantTexts}
          streamSealPendingIndex={streamSealPendingIndex}
          showHistoryHints={!isDocumentLayout}
          heightCache={heightCacheRef.current}
        />
        {themeDialogOpen ? (
          <ThemeDialog
            onSelect={(name) => {
              applyTheme(name);
              persistThemeName(name);
              setThemeDialogOpen(false);
              // Repaint the recent window with the committed palette.
              resizeRefreshRef.current = Number.NaN;
              dispatch({ type: "ADD_NOTICE", title: "Theme", text: `Theme set to "${name}". Selection saved for next start.` });
            }}
            onCancel={() => setThemeDialogOpen(false)}
          />
        ) : null}
        <Overlays
          acMode={acMode}
          input={input}
          acIndex={acIndex}
          cmdCandidates={cmdCandidates}
          fileCandidates={acMode === "workspace-diff-files" ? diffFileCandidates : fileCandidates}
          fileFragment={fileFragment}
          modelCandidates={modelCandidates}
          configuredModelCandidates={configuredModelCandidates}
          modelPickerSection={modelPickerSection}
          sessionCandidates={sessionCandidates}
          sessionCommand={sessionCommand}
          sessionLoading={sessionLoading}
          modelContextWindows={modelContextWindows}
          modelQuery={modelQuery}
          currentModel={`${llm.provider}/${llm.model}`}
          modelSetup={modelSetup}
          pendingProfileSetup={pendingProfileSetup}
          profileListState={profileListState}
          pickerItemRows={pickerLayout.itemRows}
          width={termWidth}
          effortLevels={effortLevels}
          effortLabels={THINKING_LEVEL_DISPLAY_LABELS}
          effortSelectedIndex={
            effortPreviewLevel !== undefined
              ? Math.max(0, effortLevels.indexOf(effortPreviewLevel))
              : effortSelectedIndex
          }
          termWidth={termWidth}
          onEffortPreview={handleEffortPreview}
          onEffortConfirm={handleEffortConfirm}
          onEffortCancel={handleEffortCancel}
        />
      </Box>

      <Box flexDirection="column" flexShrink={0}>
        {state.pendingPermission && (
          <PermissionPanel request={state.pendingPermission} />
        )}
        {state.pendingModeRequest && (
          <ModeRequestPanel request={state.pendingModeRequest} />
        )}
        {state.phase === "review" && state.currentPlan && (
          <PlanApprovalBar plan={state.currentPlan} />
        )}
        {pendingTodoRunPlan && (
          <TodoRunPanel plan={pendingTodoRunPlan} width={termWidth} />
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

        {/* Todos live in the pinned tail directly above the input row so the
            loading spinner (⟳) and the active step stay side by side while
            the agent is working. Rows are reserved in the feed-height budget. */}
        {(state.todoPlan || state.todoItems) && (
          <TodoPanel
            plan={state.todoPlan}
            todos={state.todoItems}
            viewMode={state.todoViewMode}
          />
        )}

        <Box
          borderStyle={useClaudeStyleInputBorder ? "round" : undefined}
          borderColor={useClaudeStyleInputBorder
            ? inputContainerBorderColor({
              permissionMode: state.permissionMode,
              busy: state.busy,
              pendingPermission: Boolean(state.pendingPermission),
            })
            : undefined}
          paddingX={1}
          gap={1}
          flexShrink={0}
          width={termWidth}
        >
          <Text color={state.busy ? C.running : C.user} bold>{state.busy ? "⟳" : "❯"}</Text>
          <Box flexGrow={1} minWidth={0}>
            <PromptInput
              key={inputEpoch}
              value={input}
              inputHistory={inputHistoryRef.current}
              disableArrowNavigation={Boolean(acMode)}
              enhancedEditingEnabled={useClaudeStyleInputBorder}
              onChange={setInputSafe}
              onPasteImage={handlePasteImageRef}
              onTab={handleTabAt}
              onScrollContext={handleScrollContext}
              onControlKey={(_keyInput, key) => {
                if (state.busy && key.ctrl && key.return) {
                  sendNowWhileBusy(input);
                  return true;
                }
                return false;
              }}
              pasteEnabled={!state.pendingPermission && !state.pendingModeRequest && !pendingTodoRunPlan}
              focus={active && !state.pendingPermission && !state.pendingModeRequest && !pendingTodoRunPlan && !bgPanelOpen && !tasksPaneOpen && !dashboardOpen && acMode !== "effort-picker" && !themeDialogOpen}
              mask={acMode === "model-setup" && modelSetup?.field === "apiKey" ? "*" : undefined}
              onSubmit={(val) => {
                if (acMode === "session-list") return;
                if (acMode === "workspace-diff-files") {
                  const selected = diffFilesRef.current[acIndex];
                  setAcMode(null);
                  setInput("");
                  if (!selected) return;
                  void new GitWorkflow(cwd).diffPath(selected).then((diff) => {
                    dispatch({ type: "ADD_NOTICE", title: `Git diff: ${selected}`, text: diff });
                  }).catch((error) => {
                    dispatch({ type: "ADD_NOTICE", title: "Git diff", text: error instanceof Error ? error.message : String(error) });
                  });
                  return;
                }
                if (shouldAcceptAutocompleteOnEnter(acMode)) {
                  if (acMode === "command") {
                    const selectedCommand = cmdCandidates[acIndex];
                    if (selectedCommand && isExactSlashCommand(val, selectedCommand.name)) {
                      inputHistoryRef.current.add(val);
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
                  if (acMode === "model-picker" && modelPickerSection === "configured") {
                    const profile = configuredModelCandidates[acIndex];
                    if (profile) {
                      activateConfiguredProfileRef(profile.name);
                      return;
                    }
                    if (!val.trim()) return;
                  }
                  if ((acMode === "model" || acMode === "model-picker") && shouldSubmitTypedModelCommand(val)) {
                    inputHistoryRef.current.add(val);
                    // The picker holds the bare query; restore the command so
                    // Enter switches the model (and forces its setup form)
                    // instead of sending the reference to the model as a prompt.
                    void handleSubmit(modelCommandFromPickerInput(val));
                    return;
                  }
                  if (acMode === "model-picker" && modelPickerSection === "configured") return;
                  const chosen = modelCandidates[acIndex];
                  if (chosen) {
                    // Enter on the catalog side selects the model and forces
                    // the credential form (Base URL → API key → model level).
                    // Tab remains the completion-only path in useAutocomplete.
                    selectModelRef(chosen, {}, { forceSetup: true });
                    return;
                  }
                }
                if (acMode === null || acMode === "command" || acMode === "model" || acMode === "model-picker") {
                  inputHistoryRef.current.add(val);
                }
                void handleSubmit(val);
              }}
              placeholder={promptPlaceholder}
            />
            {state.busy && queuedCount > 0 && <Text color={C.running}>Queue {queuedCount}</Text>}
          </Box>
        </Box>
        <StatusBar
          modelName={state.modelName}
          tokenEstimate={state.usedTokens || state.contextTokens}
          contextWindow={llm.contextWindow}
          busy={state.busy}
          status={state.status}
          queuedCount={queuedCount}
          bgTaskCount={bgTaskCount}
          mcpStatus={mcpStatus}
          goalStatus={goalStatus}
          permissionMode={state.permissionMode}
          thinkingLevel={llm.thinkingLevel ?? (llm.reasoning ? "medium" : "off")}
          cacheReadTokens={state.cacheReadTokens}
          promptTokens={state.contextTokens}
        />
        {tasksPaneOpen && (
          <>
            <TasksPane
              sessionId={conversationId}
              subagentRegistry={subagentTaskRegistry}
              bgManager={getBgManager()}
              width={Math.min(80, Math.max(60, termWidth - 4))}
              height={termHeight}
              onClose={() => setTasksPaneOpen(false)}
            />
            <Box paddingX={1}>
              <Text dimColor>Esc closes the pane and restores the prompt.</Text>
            </Box>
          </>
        )}
        {bgPanelOpen && (
          <>
            <BgTaskLivePanel
              manager={getBgManager() ?? {
                initialize: async () => {},
                list: async () => [],
                logs: async () => ({ taskId: "", text: "", offset: 0, nextOffset: 0, endOfLog: true }),
                terminate: async () => { throw new Error("Background tasks are unavailable"); },
              }}
              width={Math.min(80, Math.max(60, termWidth - 4))}
              onClose={() => setBgPanelOpen(false)}
            />
            <Box paddingX={1}>
              <Text dimColor>Esc closes the panel and restores the prompt.</Text>
            </Box>
          </>
        )}
      </Box>
    </Box>
  );
}
