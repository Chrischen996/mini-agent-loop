import React, { useReducer, useState, useCallback, useRef, useEffect, useMemo, useLayoutEffect } from "react";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Box, Text, useApp, useStdout, useInput } from "ink";
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
import { terminalStringWidth } from "./terminal-width.ts";
import { resolveAtRefs } from "./at-refs-resolver.ts";
import { runDirectTool } from "./direct-tool-runner.ts";
import { parseTodoCommand, todoViewModeForCommand } from "./todo-commands.ts";
import { addPendingImage, handlePasteImage } from "./image-handler.ts";
import { startModelSetup, commitModelSetup, openProfileList } from "./profile-manager.ts";
import { selectModel } from "./model-switcher.ts";
import { SubagentToolsFactory } from "./subagent-tools-factory.ts";
import { formatAmbiguousSessionNotice, parseForeignResumeCommand, parseResumeCommand, restoreLlmConfig, restoreTuiSession, toPersistedTodos } from "./session-serialization.ts";
import { resolveSessionByPrefix, SessionManager } from "../session-manager.ts";
import { ForeignSessionError, formatForeignSessionList, importForeignSession, listForeignSessions } from "../foreign-session.ts";
import type { PersistedSession } from "../session-store.ts";
import { formatMcpStatus, formatMcpStatusDetails } from "../mcp/status.ts";
import type { McpServerStatus } from "../mcp/types.ts";
import { BgTaskManager, stableBgTaskInstanceId } from "../bg-tasks/manager.js";
import { GitWorkflow } from "../git/workflow.ts";
import { BgTaskLivePanel } from "./components/BgTaskLivePanel.tsx";
import { AgentDashboard, type DashboardAgent } from "./components/AgentDashboard.tsx";
import { TodoRunPanel } from "./components/TodoRunPanel.tsx";
import { useKeyboardHandler } from "./hooks/useKeyboardHandler.ts";
import { SmoothScrollController } from "./smooth-scroll.ts";
import { TerminalInputHistory } from "./terminal-input-history.ts";
import { buildTuiSystemPrompt, createTuiAgentHistory, type TuiSystemPromptContext } from "./system-prompt.ts";

import { TUI_COLORS as C } from "./theme.ts";
import { estimatePromptInputRows, PromptInput } from "./components/PromptInput.tsx";
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
import { runTodos, todosRunExecutors, type TodosRunExecutors } from "./tui-core/command-runners.ts";
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
import type { StartupSessionRequest } from "./session-serialization.ts";

type AppProps = {
  cwd: string;
  /** Stable project identity; a session may execute from an isolated worktree. */
  projectCwd?: string;
  systemPromptContext?: TuiSystemPromptContext;
  startupSessionRequest?: StartupSessionRequest;
  agentTools?: ToolProvider;
  allTools?: ToolProvider;
  agentToolsForCwd?: (cwd: string) => ToolProvider;
  allToolsForCwd?: (cwd: string) => ToolProvider;
  worktreeIsolation?: boolean;
  /** Compact MCP status source for the status bar; polled when present. */
  mcpStatuses?: () => readonly McpServerStatus[];
  /** Current MCP tool catalog, used by `/mcp <server>` details. */
  mcpTools?: () => readonly Tool[];
};
type ManagedAgent = DashboardAgent & {
  initialSessionId: string;
  initialPrompt?: string;
  cwd?: string;
  launching?: boolean;
};
type DashboardAgentSnapshot = Omit<DashboardAgent, "name">;
type AgentSessionAppProps = AppProps & {
  agentId: string;
  initialSessionId: string;
  initialPrompt?: string;
  projectCwd: string;
  active: boolean;
  dashboardOpen: boolean;
  onOpenDashboard: () => void;
  onCloseDashboard: () => void;
  onSnapshot: (snapshot: DashboardAgentSnapshot) => void;
  onWorkspaceChange: (agentId: string, cwd: string, branch?: string) => void;
};
const DEFAULT_IMAGE_PROMPT = "请分析附件中的图片";

function useLazyRef<T>(factory: () => T): React.MutableRefObject<T> {
  const ref = useRef<T | undefined>(undefined);
  if (ref.current === undefined) ref.current = factory();
  return ref as React.MutableRefObject<T>;
}

async function resolveSessionWorkspaceCwd(projectCwd: string, candidatePath?: string): Promise<string> {
  const root = await realpath(projectCwd).catch(() => path.resolve(projectCwd));
  const requested = path.resolve(candidatePath ?? root);
  let candidate: string;
  try {
    if (!(await stat(requested)).isDirectory()) return root;
    candidate = await realpath(requested);
  } catch {
    return root;
  }
  const relative = path.relative(root, candidate);
  if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    return candidate;
  }
  try {
    if (await new GitWorkflow(root).isRegisteredWorktree(candidate)) return candidate;
  } catch {
    // Missing or unregistered session paths fall back to the project root.
  }
  return root;
}

async function startupSessionCwd(projectCwd: string, request: StartupSessionRequest): Promise<string> {
  const manager = new SessionManager({ workspaceId: projectCwd });
  const session = request.sessionId
    ? await manager.load(request.sessionId)
    : request.resume || request.continueSession || request.fork
      ? await manager.loadMostRecent()
      : undefined;
  return resolveSessionWorkspaceCwd(projectCwd, session?.cwd);
}

function AgentSessionApp({ cwd, projectCwd, systemPromptContext = {}, startupSessionRequest, agentTools, allTools, agentToolsForCwd, allToolsForCwd, mcpStatuses, mcpTools, agentId, initialSessionId, initialPrompt, active, dashboardOpen, onOpenDashboard, onCloseDashboard, onSnapshot, onWorkspaceChange }: AgentSessionAppProps): React.ReactElement | null {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [terminalSize, setTerminalSize] = useState(() => ({
    columns: stdout?.columns || 80,
    rows: stdout?.rows || 24,
  }));
  useEffect(() => {
    if (!stdout) return;
    const syncTerminalSize = () => {
      const columns = stdout.columns || 80;
      const rows = stdout.rows || 24;
      setTerminalSize((current) =>
        current.columns === columns && current.rows === rows
          ? current
          : { columns, rows },
      );
    };
    stdout.on("resize", syncTerminalSize);
    syncTerminalSize();
    return () => {
      stdout.off("resize", syncTerminalSize);
    };
  }, [stdout]);
  const termWidth = terminalSize.columns;
  // Leave one terminal row unused so Ink never enters its full-screen clear
  // path (`outputHeight >= rows`) while streamed reasoning is growing.
  const termHeight = getTuiViewportHeight(terminalSize.rows);
  const [llm, setLlm] = useState<LlmConfig>(() => loadLlmConfigFromEnv());
  const llmRef = useRef(llm);
  llmRef.current = llm;
  const vision = useMemo(() => loadVisionConfigFromEnv(), []);
  const autoSubagent = useMemo(() => loadAutoSubagentOptionsFromEnv(), []);
  const globalTokenBudget = useMemo(() => loadGlobalTokenBudgetFromEnv(), []);
  const globalConcurrencyLimit = useMemo(() => loadGlobalConcurrencyLimitFromEnv(), []);
  const [skillNames, setSkillNames] = useState<string[]>(() => loadSkillNamesFromEnv());
  const skillNamesRef = useRef(skillNames);
  skillNamesRef.current = skillNames;
  const allToolsRef = useLazyRef(() => allToolsForCwd?.(cwd) ?? allTools ?? createAllTools(cwd));
  const agentToolsRef = useLazyRef(() => agentToolsForCwd?.(cwd) ?? agentTools ?? createTools(cwd, { codebase: process.env.EXTERNAL_CODEBASE_ENABLED !== "0" }));
  useEffect(() => {
    if (allToolsForCwd) allToolsRef.current = allToolsForCwd(cwd);
    if (agentToolsForCwd) agentToolsRef.current = agentToolsForCwd(cwd);
  }, [cwd, allToolsForCwd, agentToolsForCwd]);

  // Lazy background-task manager for the /bg-tasks slash command. Created on
  // first use so TUI startup is not blocked when tmux is unavailable.
  const bgManagerRef = useRef<BgTaskManager | null | "unavailable">(null);
  useEffect(() => {
    const manager = bgManagerRef.current;
    if (manager && manager !== "unavailable") manager.dispose();
    bgManagerRef.current = null;
  }, [cwd]);
  const getBgManager = useCallback((): BgTaskManager | null => {
    if (bgManagerRef.current === "unavailable") return null;
    if (bgManagerRef.current) return bgManagerRef.current;
    const bgEnabled = process.env.MINI_AGENT_BG_TASKS !== "0" && process.env.MINI_AGENT_BG_TASKS !== "false";
    if (!bgEnabled) {
      bgManagerRef.current = "unavailable";
      return null;
    }
    try {
      const instanceId = stableBgTaskInstanceId(cwd);
      bgManagerRef.current = new BgTaskManager(cwd, instanceId);
      return bgManagerRef.current;
    } catch {
      bgManagerRef.current = "unavailable";
      return null;
    }
  }, [cwd]);
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

  // Executors for `/tasks run --parallel` (subagent + background tasks).
  const todosExecutorsRef = useRef<TodosRunExecutors | null>(null);
  const getTodosRunExecutors = useCallback((): TodosRunExecutors => {
    if (todosExecutorsRef.current) return todosExecutorsRef.current;
    todosExecutorsRef.current = todosRunExecutors({
      getBgManager,
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
  const jumpToBottomRef = useRef<() => void>(() => undefined);
  const inputHistoryRef = useLazyRef(() => new TerminalInputHistory());
  // Generate a stable conversation session ID on startup
  const [conversationId, setConversationId] = useState(() => initialSessionId || process.env.MINI_AGENT_SESSION_ID || randomUUID());

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
        {
          store: {
            getState: () => stateRef.current,
            dispatch: (action: import("./state.ts").TuiAction) =>
              dispatchRef.current(action),
            subscribe: () => () => undefined,
          },
          sessionRef: { current: conversationIdRef.current },
          permissionManager: getPermissionManagerRef.current(),
          cwd,
          allTools: agentToolsRef.current,
          recordSubmission: (text) => void text,
          clearInput: () => setInputRef.current(""),
          abortSignal: abortControllerRef.current.signal,
          persistTodoState: (todos) => void todos,
          todosRunExecutors: getTodosRunExecutors(),
          onConfirmTodoRun: (pending) => {
            confirmedTodoRunRef.current = pending;
            setPendingTodoRunPlan(pending);
          },
          todoRunConfirmed: confirmed,
          todoRunSnapshot: approvedPlan?.todos,
        },
        {
          cmd: "todos-run",
          args: approvedPlan?.parsed ?? parsed.args,
        },
      );
      confirmedTodoRunRef.current = undefined;
      dispatchRef.current({ type: "LOOP_EVENT", event: { type: "done", messages: historyRef.current } });
    },
    [cwd, agentToolsRef, getTodosRunExecutors],
  );

  const pendingImagesRef = useRef<ImageAttachment[]>([]);
  pendingImagesRef.current = state.pendingImages;
  const promptQueueRef = useRef<string[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);
  const [input, setInput] = useState("");
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

  const smoothScrollRef = useLazyRef(() => new SmoothScrollController({
    getOffset: () => stateRef.current.scrollOffset,
    getMaxOffset: () => stateRef.current.maxScrollOffset,
    scrollTo: (offset) => dispatchRef.current({ type: "SCROLL_TO", offset }),
  }));
  const scrollBy = useCallback((delta: number) => {
    smoothScrollRef.current.scrollBy(delta);
  }, [smoothScrollRef]);
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
    if (pendingPermissionRef.current) return;
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

  const resumeSession = useCallback(async (prefix: string, fork = false): Promise<boolean> => {
    const manager = getSessionManager();
    try {
      const selection = resolveSessionByPrefix(await manager.list(), prefix);
      if (!selection.session) {
        dispatch({
          type: "ADD_NOTICE",
          title: "Resume session",
          text: selection.candidates.length > 1
            ? formatAmbiguousSessionNotice(prefix, selection.candidates)
            : prefix ? `Session not found: ${prefix}` : "No resumable sessions found.",
        });
        return false;
      }

      const loaded = await manager.load(selection.session.id);
      const session = loaded && fork ? await manager.fork(loaded.id) : loaded;
      if (!session) {
        dispatch({ type: "ADD_NOTICE", title: "Resume session", text: `Session not found: ${selection.session.id}` });
        return false;
      }

      const sessionCwd = await resolveSessionWorkspaceCwd(projectCwd, session.cwd);
      if (path.resolve(sessionCwd) !== path.resolve(cwd)) {
        const projectRoot = await realpath(projectCwd).catch(() => path.resolve(projectCwd));
        const branch = sessionCwd === projectRoot
          ? undefined
          : await new GitWorkflow(sessionCwd).status().then((status) => status.branch).catch(() => undefined);
        onWorkspaceChange(agentId, sessionCwd, branch);
      }

      const permissionMode = session.permissionMode ?? "plan";
      const restored = restoreTuiSession(session, buildTuiSystemPrompt(permissionMode, systemPromptContext));
      const restoredLlm = restoreLlmConfig(llmRef.current, session);
      const restoredSkillNames = session.skillNames ? [...session.skillNames] : loadSkillNamesFromEnv();
      manager.setSessionId(session.id);
      setConversationId(session.id);
      historyRef.current = restored.history;
      activeTodosRef.current = restored.todos;
      thinkingPolicyModeRef.current = session.thinkingMode ?? loadThinkingModeFromEnv();
      sessionProvenanceRef.current = {
        parentSessionId: session.parentSessionId,
        forkedFromMessage: session.forkedFromMessage,
        forkedFromMessageId: session.forkedFromMessageId,
        origin: session.origin,
      };
      getPermissionManager().setMode(permissionMode);
      llmRef.current = restoredLlm;
      setLlm(restoredLlm);
      setSkillNames(restoredSkillNames);
      skillNamesRef.current = restoredSkillNames;
      dispatch({ type: "MODEL_CHANGED", modelName: restoredLlm.model });
      dispatch({
        type: "RESTORE_SESSION",
        history: restored.history,
        modelName: restoredLlm.model,
        thinkingMode: stateRef.current.thinkingMode,
        permissionMode,
        phase: session.phase,
        currentPlan: session.currentPlan,
        todos: restored.todos,
        todoRevision: restored.todoRevision,
      });
      return true;
    } catch (error) {
      dispatch({
        type: "ADD_NOTICE",
        title: "Resume session",
        text: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }, [agentId, cwd, dispatch, getPermissionManager, getSessionManager, onWorkspaceChange, projectCwd, setConversationId, setLlm, setSkillNames, systemPromptContext]);

  const importForeign = useCallback(async (source: "claude" | "codex", reference: string): Promise<void> => {
    const manager = getSessionManager();
    if (!reference) {
      try {
        const listed = formatForeignSessionList(source, (await listForeignSessions(source, cwd)).sessions);
        dispatch({ type: "ADD_NOTICE", title: source === "claude" ? "Claude Code sessions" : "Codex sessions", text: listed });
      } catch (error) {
        dispatch({ type: "ADD_NOTICE", title: "Import session", text: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    try {
      const imported = await importForeignSession(manager, source, cwd, reference, cwd);
      const permissionMode = imported.session.permissionMode ?? "plan";
      const restored = restoreTuiSession(imported.session, buildTuiSystemPrompt(permissionMode, systemPromptContext));
      manager.setSessionId(imported.session.id);
      setConversationId(imported.session.id);
      sessionProvenanceRef.current = { origin: imported.session.origin };
      historyRef.current = restored.history;
      activeTodosRef.current = restored.todos;
      getPermissionManager().setMode(permissionMode);
      dispatch({
        type: "RESTORE_SESSION",
        history: restored.history,
        modelName: llmRef.current.model,
        thinkingMode: stateRef.current.thinkingMode,
        permissionMode,
        phase: imported.session.phase,
        currentPlan: imported.session.currentPlan,
        todos: restored.todos,
        todoRevision: restored.todoRevision,
      });
      dispatch({
        type: "ADD_NOTICE",
        title: source === "claude" ? "Imported Claude Code session" : "Imported Codex session",
        text: `${imported.created ? "Imported" : "Reopened"} ${imported.transcript.session_id} as ${imported.session.id}.`,
      });
    } catch (error) {
      const text = error instanceof ForeignSessionError && error.matches.length > 0
        ? `${error.message}\n${formatForeignSessionList(source, error.matches)}`
        : error instanceof Error ? error.message : String(error);
      dispatch({ type: "ADD_NOTICE", title: "Import session", text });
    }
  }, [agentId, cwd, dispatch, getPermissionManager, getSessionManager, onWorkspaceChange, projectCwd, setConversationId, systemPromptContext]);

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

  const sessionSnapshotFields = useCallback(() => {
    const current = stateRef.current;
    return {
      id: conversationIdRef.current,
      modelId: llmRef.current.model,
      thinkingLevel: llmRef.current.thinkingLevel,
      thinkingMode: thinkingPolicyModeRef.current,
      permissionMode: getPermissionManager().getMode(),
      skillNames: [...skillNamesRef.current],
      phase: current.phase,
      currentPlan: current.currentPlan,
      todos: toPersistedTodos(activeTodosRef.current),
      todoVersion: current.todoRevision,
      cwd,
      ...sessionProvenanceRef.current,
    };
  }, [cwd, getPermissionManager]);

  const persistSessionSnapshot = useCallback(async (messages: AgentMessage[]) => {
    try {
      await getSessionManager().save({ ...sessionSnapshotFields(), messages: [...messages] });
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
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [mcpStatuses]);

  const {
    acMode,
    setAcMode,
    acIndex,
    setAcIndex,
    cmdCandidates,
    fileCandidates,
    modelCandidates,
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
      .then((plan) => dispatch({ type: "SET_TODO_PLAN", plan: plan ?? undefined }))
      .catch(() => { /* a missing or unreadable plan is non-fatal */ });
  }, [cwd]);

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
          : acMode === "profile-list" ? Math.min(10, profileListState?.profiles.length ?? 0)
            : acMode ? 4 : 0;
  const promptPlaceholder = state.busy ? "运行中，可输入消息并排队"
    : acMode === "model-picker" ? "搜索模型"
      : acMode === "model-setup" && modelSetup?.field === "baseUrl" ? "输入 Base URL"
        : acMode === "model-setup" ? "输入 API Key，可留空使用环境变量"
          : acMode === "profile-name" ? "输入配置文件名称（例如 coding-fast）"
            : acMode === "profile-list" ? "↑↓ 选择配置文件，Enter 激活"
              : "输入消息，/ 命令，或 @文件 引用";
  const promptWidth = Math.max(
    1,
    termWidth - 4 - (state.busy && queuedCount > 0 ? terminalStringWidth(`队列 ${queuedCount}`) : 0),
  );
  const promptRows = estimatePromptInputRows(input, promptWidth, promptPlaceholder);
  const extraFooterRows = state.spinnerMessage ? 1 : 0;
  const todoRows = getTodoPanelRows(
    { plan: state.todoPlan, todos: state.todoItems },
    state.todoViewMode,
  );
  // Approval chrome: the permission card / plan approval bar render between
  // the feed and the input row; reserve their rows in every height budget.
  const permissionRows = (state.pendingPermission ? 4 : 0) + (pendingTodoRunPlan ? 5 : 0);
  const planApprovalRows = state.phase === "review" && state.currentPlan ? 3 : 0;
  const pickerLayout = getPickerLayout({
    termRows: terminalSize.rows,
    requestedItems: requestedPickerItems,
    inputRows: promptRows,
    hasPendingImages: state.pendingImages.length > 0,
    todoRows,
    extraFooterRows,
    extraRows: acMode === "model" || acMode === "model-picker" || acMode === "file" ? 3 : 2,
    permissionRows,
    planApprovalRows,
  });
  const feedHeight = getMessageFeedHeight({
    termRows: terminalSize.rows,
    inputRows: promptRows,
    hasPendingImages: state.pendingImages.length > 0,
    todoRows,
    pickerRows: pickerLayout.totalRows,
    extraFooterRows,
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
    adjustThinkingLevel, resolvePendingPermission, dispatch, scrollBy, jumpToBottom,
    acMode, state, feedHeight, handleAutocompleteKey, historyRef,
    suppressInputEchoRef, pendingPermissionRef,
    bgPanelOpen, onCloseBgPanel: () => setBgPanelOpen(false),
    dashboardOpen, onCloseDashboard, onOpenDashboard,
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

  const handleSubmit = useCallback(async (text: string) => {
    const trimmed = text.trim();
    const allowEmptyApiKey = acMode === "model-setup" && modelSetup?.field === "apiKey";
    const hasPendingImages = pendingImagesRef.current.length > 0;
    if (!trimmed && !allowEmptyApiKey && !hasPendingImages) return;
    jumpToBottom();
    if (trimmed === "/dashboard") {
      onOpenDashboard();
      setAcMode(null);
      setInput("");
      return;
    }
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
        void commitModelSetup(modelSetup, trimmed, {
          llm, setLlm, setModelSetup, setAcMode, setInput, setAcIndex, setProfileListState, dispatch, historyRef,
        });
      }
      return;
    }

    clearAc();

    const foreignResume = parseForeignResumeCommand(trimmed);
    if (foreignResume) {
      setInput("");
      await importForeign(foreignResume.source, foreignResume.reference);
      return;
    }
    const resumeCommand = parseResumeCommand(trimmed);
    if (resumeCommand) {
      setInput("");
      if (resumeCommand.prefix) {
        await resumeSession(resumeCommand.prefix);
      } else {
        setInput("/resume");
      }
      return;
    }
    if (trimmed === "/sessions") {
      setInput("/sessions");
      return;
    }

    if (trimmed === "/bg-tasks") {
      setBgPanelOpen(true);
      const manager = getBgManager();
      if (!manager) {
        dispatch({
          type: "ADD_NOTICE",
          title: "Background tasks",
          text: process.env.MINI_AGENT_BG_TASKS === "0" || process.env.MINI_AGENT_BG_TASKS === "false"
            ? "Background tasks are disabled (MINI_AGENT_BG_TASKS=0)."
            : "Background tasks are unavailable in this session.",
        });
        setInput("");
        return;
      }
      try {
        await manager.initialize();
        const tasks = await manager.list();
        if (tasks.length === 0) {
          dispatch({ type: "ADD_NOTICE", title: "Background tasks", text: "No background tasks started yet." });
        } else {
          const lines = tasks.map((task) => {
            const duration = task.durationMs !== undefined ? ` · ${Math.round(task.durationMs / 1000)}s` : "";
            const exit = task.exitCode !== null && task.exitCode !== undefined ? ` · exit ${task.exitCode}` : "";
            return `${task.status.padEnd(11)} ${task.taskId.slice(0, 8)}  ${task.name}${duration}${exit}`;
          });
          dispatch({
            type: "ADD_NOTICE",
            title: `Background tasks (${tasks.length})`,
            text: lines.join("\n"),
          });
        }
        void refreshBgTaskCount();
      } catch (error) {
        dispatch({
          type: "ADD_NOTICE",
          title: "Background tasks",
          text: error instanceof Error ? error.message : String(error),
        });
      }
      setInput("");
      return;
    }
    if (/^\/mcp(?:\s+.*)?$/i.test(trimmed)) {
      const command = parseSlashCommand(trimmed);
      if (command?.cmd === "mcp") {
        let text: string;
        try {
          const tools = command.serverId
            ? mcpTools?.() ?? resolveToolProvider(allToolsRef.current)
            : [];
          text = formatMcpStatusDetails(
            mcpStatuses?.(),
            tools,
            command.serverId,
          );
        } catch {
          text = "Unable to read MCP status in this session.";
        }
        dispatch({ type: "ADD_NOTICE", title: "MCP status", text });
      } else {
        dispatch({ type: "ADD_NOTICE", title: "MCP status", text: "Usage: /mcp [server]" });
      }
      setInput("");
      return;
    }
    if (trimmed === "/exit" || trimmed === "/quit") { exit(); return; }
    if (trimmed === "/clear") {
      historyRef.current = createTuiAgentHistory(getPermissionManager().getMode(), systemPromptContext);
      pendingImagesRef.current = [];
      dispatch({ type: "RESET" });
      setInput("");
      // Generate new conversation ID for fresh session
      const nextSessionId = randomUUID();
      sessionManagerRef.current?.newSession(nextSessionId);
      sessionProvenanceRef.current = {};
      activeTodosRef.current = undefined;
      setConversationId(nextSessionId);
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
      if (slashCmd.cmd === "todos-run") {
        void runTodosCommand(trimmed, slashCmd);
        return;
      }
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
    if (parsedThinking.intensity) {
      llmRef.current = turnLlm;
      setLlm(turnLlm);
    }
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
      ? thinkingPolicyModeRef.current
      : parsedThinking.intensity
        ? "fixed"
        : parseThinkingCommandMode(prompt) ?? thinkingPolicyModeRef.current;
    thinkingPolicyModeRef.current = thinkingMode;
    let turnSucceeded = false;
    let turnErrorMessage: string | undefined;

    const onLoopEvent = (event: LoopEvent) => {
      if (event.type === "thinking_policy") {
        turnLlm = withThinkingLevel(turnLlm, event.level);
        llmRef.current = turnLlm;
        setLlm(turnLlm);
      } else if (event.type === "todo_updated") {
        activeTodosRef.current = event.todos;
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
      } else if (event.type === "tool_start" && event.call.name.startsWith("bg_")) {
        // A bg_* call from the agent starts the badge without requiring the
        // user to run /bg-tasks first.
        void refreshBgTaskCount();
      }
      streamBuffer.handle(runId, event);
    };

    try {
      let currentUserContent = planTurnOverride
        ? prompt
        : await resolveAtRefsRef(prompt, permissionTurn);
      if (imageParts.length > 0) {
        const contentParts = typeof currentUserContent === "string"
          ? [{ type: "text" as const, text: currentUserContent }]
          : currentUserContent;
        currentUserContent = [...contentParts, ...imageParts];
      }

      try {
        await getSessionManager().saveTurnStart({
          ...sessionSnapshotFields(),
          messages: historyRef.current,
          content: currentUserContent,
        });
      } catch (error) {
        dispatch({
          type: "ADD_NOTICE",
          title: "Session save failed",
          text: error instanceof Error ? error.message : String(error),
        });
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
            sessionPhase: stateRef.current.currentPlan ? stateRef.current.phase : undefined,
            runtimeContext: {
              sessionId: conversationId,
              workspaceId: projectCwd,
              cwd,
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
            onCheckpoint: async (checkpoint) => {
              historyRef.current = checkpoint.messages;
              await persistSessionSnapshot(checkpoint.messages);
            },
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
      await persistSessionSnapshot(historyRef.current);
    }
  }, [state, llm, vision, exit, runDirectToolRef, resolveAtRefsRef, clearAc, commitModelSetup, openProfileListRef, getPermissionManager, addPendingImageRef, handlePasteImageRef, conversationId, cwd, projectCwd, copyResolvedText, globalTokenBudget, globalConcurrencyLimit, getBgManager, refreshBgTaskCount, resumeSession, sessionSnapshotFields, getSessionManager, persistSessionSnapshot, mcpStatuses, mcpTools, jumpToBottom, onOpenDashboard]);

  const initialPromptStartedRef = useRef(false);
  useEffect(() => {
    if (!initialPrompt || initialPromptStartedRef.current) return;
    initialPromptStartedRef.current = true;
    void handleSubmit(initialPrompt);
  }, [handleSubmit, initialPrompt]);

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
  const handleScrollContext = useCallback((direction: "up" | "down") => {
    scrollBy(direction === "up" ? 3 : -3);
  }, [scrollBy]);
  const previousViewportHeightRef = useRef(viewportContentHeight);
  useLayoutEffect(() => {
    const previous = previousViewportHeightRef.current;
    previousViewportHeightRef.current = viewportContentHeight;
    if (state.scrollOffset > 0 && viewportContentHeight > previous) {
      dispatch({ type: "SCROLL_BY", delta: viewportContentHeight - previous });
    }
  }, [dispatch, viewportContentHeight, state.scrollOffset]);

  useLayoutEffect(() => {
    dispatch({
      type: "SET_MAX_SCROLL_OFFSET",
      offset: Math.max(0, viewportContentHeight - Math.max(1, Math.max(3, feedHeight) - 1)),
    });
  }, [dispatch, viewportContentHeight, feedHeight]);

  useEffect(() => {
    const status = state.pendingPermission ? "Needs input"
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
      active: state.busy || Boolean(state.pendingPermission),
      failed: state.taskStatus === "failed",
      startedAt: state.taskStartedAt,
      workspace: cwd,
    });
  }, [agentId, cwd, onSnapshot, state]);

  if (!active || dashboardOpen) return null;

  return (
    <Box flexDirection="column" width={termWidth} height={termHeight} overflow="hidden">
      <Header modelName={state.modelName} cwd={cwd} dashboardOpen={dashboardOpen} />

      {(state.todoPlan || state.todoItems) && (
        <TodoPanel
          plan={state.todoPlan}
          todos={state.todoItems}
          viewMode={state.todoViewMode}
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
        />
      </Box>

      <Box flexDirection="column" flexShrink={0}>
        {state.pendingPermission && (
          <PermissionPanel request={state.pendingPermission} />
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
        {state.spinnerMessage && (
          <Box paddingX={1} paddingY={0}>
            <Text dimColor>{state.spinnerMessage}</Text>
          </Box>
        )}
        <Box paddingX={1} gap={1} flexShrink={0}>
          <Text color={state.busy ? C.running : C.user} bold>{state.busy ? "⟳" : ">"}</Text>
          <Box flexGrow={1} minWidth={0}>
            <PromptInput
              key={inputEpoch}
              value={input}
              inputHistory={inputHistoryRef.current}
              disableArrowNavigation={Boolean(acMode)}
              onChange={setInputSafe}
              onPasteImage={handlePasteImageRef}
              onTab={handleTabAt}
              onScrollContext={handleScrollContext}
              pasteEnabled={!state.pendingPermission && !pendingTodoRunPlan}
              focus={active && !state.pendingPermission && !pendingTodoRunPlan && !bgPanelOpen && !dashboardOpen}
              mask={acMode === "model-setup" && modelSetup?.field === "apiKey" ? "*" : undefined}
              onSubmit={(val) => {
                if (acMode === "session-list") return;
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
                  if ((acMode === "model" || acMode === "model-picker") && shouldSubmitTypedModelCommand(val)) {
                    inputHistoryRef.current.add(val);
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
                if (acMode === null || acMode === "command" || acMode === "model" || acMode === "model-picker") {
                  inputHistoryRef.current.add(val);
                }
                void handleSubmit(val);
              }}
              placeholder={promptPlaceholder}
            />
            {state.busy && queuedCount > 0 && <Text color={C.running}>队列 {queuedCount}</Text>}
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
          permissionMode={state.permissionMode}
          thinkingLevel={llm.thinkingLevel ?? (llm.reasoning ? "medium" : "off")}
          cacheReadTokens={state.cacheReadTokens}
          promptTokens={state.contextTokens}
        />
        {bgPanelOpen && (
          <>
            <BgTaskLivePanel
              manager={getBgManager() ?? { initialize: async () => {}, list: async () => [], logs: async () => ({ taskId: "", text: "", offset: 0, nextOffset: 0, endOfLog: true }) }}
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

export function App(props: AppProps): React.ReactElement {
  const projectCwd = props.projectCwd ?? props.cwd;
  const { stdout } = useStdout();
  const [terminalSize, setTerminalSize] = useState(() => ({
    columns: stdout?.columns || 80,
    rows: stdout?.rows || 24,
  }));
  useEffect(() => {
    if (!stdout) return;
    const syncTerminalSize = () => {
      const columns = stdout.columns || 80;
      const rows = stdout.rows || 24;
      setTerminalSize((current) => current.columns === columns && current.rows === rows
        ? current
        : { columns, rows });
    };
    stdout.on("resize", syncTerminalSize);
    syncTerminalSize();
    return () => {
      stdout.off("resize", syncTerminalSize);
    };
  }, [stdout]);
  const initialAgentIdRef = useRef<string | undefined>(undefined);
  if (!initialAgentIdRef.current) initialAgentIdRef.current = randomUUID();
  const initialAgentId = initialAgentIdRef.current;
  const initialSessionId = props.startupSessionRequest?.sessionId
    ?? process.env.MINI_AGENT_SESSION_ID
    ?? initialAgentId;
  const shouldResolveStartupCwd = Boolean(props.startupSessionRequest
    && (props.startupSessionRequest.resume || props.startupSessionRequest.continueSession || props.startupSessionRequest.fork));
  const [agents, setAgents] = useState<ManagedAgent[]>(() => [{
    id: initialAgentId,
    initialSessionId,
    name: "Main agent",
    task: "No request submitted",
    status: shouldResolveStartupCwd ? "Preparing" : "Idle",
    activity: shouldResolveStartupCwd ? "Restoring workspace" : "Ready",
    active: false,
    failed: false,
    cwd: shouldResolveStartupCwd ? undefined : props.cwd,
    workspace: shouldResolveStartupCwd ? undefined : props.cwd,
    launching: shouldResolveStartupCwd,
  }]);
  const [activeAgentId, setActiveAgentId] = useState(initialAgentId);
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [worktreeIsolation, setWorktreeIsolation] = useState(props.worktreeIsolation ?? true);
  const nextAgentNumberRef = useRef(2);

  useEffect(() => {
    const request = props.startupSessionRequest;
    if (!request || !shouldResolveStartupCwd) return;
    let cancelled = false;
    void startupSessionCwd(projectCwd, request).then((cwd) => {
      if (cancelled) return;
      setAgents((current) => current.map((agent) => agent.id === initialAgentId
        ? { ...agent, cwd, workspace: cwd, launching: false, status: "Idle", activity: "Ready" }
        : agent));
    }).catch(() => {
      if (cancelled) return;
      setAgents((current) => current.map((agent) => agent.id === initialAgentId
        ? { ...agent, cwd: props.cwd, workspace: props.cwd, launching: false, status: "Idle", activity: "Ready" }
        : agent));
    });
    return () => { cancelled = true; };
  }, [initialAgentId, projectCwd, props.cwd, props.startupSessionRequest, shouldResolveStartupCwd]);

  const updateAgentSnapshot = useCallback((snapshot: DashboardAgentSnapshot) => {
    setAgents((current) => current.map((agent) => agent.id === snapshot.id
      ? { ...agent, ...snapshot }
      : agent));
  }, []);
  const updateAgentWorkspace = useCallback((agentId: string, cwd: string, branch?: string) => {
    setAgents((current) => current.map((agent) => agent.id === agentId
      ? { ...agent, cwd, workspace: cwd, branch, launching: false }
      : agent));
  }, []);
  const openDashboard = useCallback(() => setDashboardOpen(true), []);
  const closeDashboard = useCallback(() => setDashboardOpen(false), []);
  const dispatchAgent = useCallback((prompt: string, attach: boolean) => {
    const id = randomUUID();
    const agentNumber = nextAgentNumberRef.current++;
    const isolate = worktreeIsolation;
    setAgents((current) => [{
      id,
      initialSessionId: id,
      initialPrompt: prompt,
      name: `Agent ${agentNumber}`,
      task: prompt,
      status: isolate ? "Preparing" : "Working",
      activity: isolate ? "Creating isolated worktree" : "Starting",
      active: !isolate,
      failed: false,
      startedAt: Date.now(),
      cwd: isolate ? undefined : props.cwd,
      workspace: isolate ? undefined : props.cwd,
      launching: isolate,
    }, ...current]);

    if (!isolate) {
      if (attach) {
        setActiveAgentId(id);
        setDashboardOpen(false);
      }
      return;
    }

    void new GitWorkflow(projectCwd).createIsolatedBranch(`agent-${agentNumber}-${id.slice(0, 8)}`).then((isolated) => {
      setAgents((current) => current.map((agent) => agent.id === id
        ? {
            ...agent,
            cwd: isolated.path,
            workspace: isolated.path,
            branch: isolated.branch,
            launching: false,
            status: "Working",
            activity: "Starting",
            active: true,
          }
        : agent));
      if (attach) {
        setActiveAgentId(id);
        setDashboardOpen(false);
      }
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setAgents((current) => current.map((agent) => agent.id === id
        ? {
            ...agent,
            launching: false,
            status: "Failed",
            activity: "Worktree setup failed",
            active: false,
            failed: true,
            setupError: message,
          }
        : agent));
    });
  }, [projectCwd, props.cwd, worktreeIsolation]);
  const openAgent = useCallback((id: string) => {
    const agent = agents.find((candidate) => candidate.id === id);
    if (!agent?.cwd) return;
    setActiveAgentId(id);
    setDashboardOpen(false);
  }, [agents]);
  const toggleWorktreeIsolation = useCallback(() => {
    setWorktreeIsolation((current) => !current);
  }, []);

  return (
    <>
      {agents.filter((agent) => Boolean(agent.cwd) && !agent.launching).map((agent) => (
        <AgentSessionApp
          key={agent.id}
          {...props}
          cwd={agent.cwd!}
          projectCwd={projectCwd}
          startupSessionRequest={agent.id === initialAgentId ? props.startupSessionRequest : undefined}
          agentId={agent.id}
          initialSessionId={agent.initialSessionId}
          initialPrompt={agent.initialPrompt}
          active={activeAgentId === agent.id && !dashboardOpen}
          dashboardOpen={dashboardOpen}
          onOpenDashboard={openDashboard}
          onCloseDashboard={closeDashboard}
          onSnapshot={updateAgentSnapshot}
          onWorkspaceChange={updateAgentWorkspace}
        />
      ))}
      {dashboardOpen && (
        <AgentDashboard
          agents={agents}
          activeAgentId={activeAgentId}
          width={terminalSize.columns}
          height={getTuiViewportHeight(terminalSize.rows)}
          onClose={closeDashboard}
          onDispatch={dispatchAgent}
          onOpenAgent={openAgent}
          worktreeIsolation={worktreeIsolation}
          onToggleWorktreeIsolation={toggleWorktreeIsolation}
        />
      )}
    </>
  );
}
