import process from "node:process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createSandboxRunner } from "../sandbox/index.ts";
import { createCodebaseRuntimeFromEnv } from "../codebase/runtime.ts";
import { createMcpRuntimeFromEnv } from "../mcp/runtime.ts";
import { createAllTools, createTools } from "../tools/index.ts";
import { resolveToolProvider, type ToolProvider } from "../tools/types.ts";
import { loadLlmConfigFromEnv, switchLlmModel } from "../llm/index.ts";
import { findExactModelReferenceMatch, getAllModels, resolveModel } from "../models.ts";
import { createVisionPreprocessor, loadVisionConfigFromEnv } from "../preprocessors/index.ts";
import { loadAutoSubagentOptionsFromEnv } from "../subagent/index.ts";
import { applySkillCommand, discoverWorkspaceSkills, loadSkillNamesFromEnv, defaultSkillRegistry } from "../skills/index.ts";
import { PermissionManager } from "../permissions.ts";
import { applyPermissionModePrompt, createAgentHistory, type AgentRuntimeRef } from "../loop.ts";
import { cycleThinkingLevel, thinkingLevelToDisplay, withThinkingLevel } from "../think-intensity.ts";
import { nextPermissionMode, switchPermissionMode } from "./permission-utils.ts";
import { parseTodoCommand, todoViewModeForCommand } from "./todo-commands.ts";
import { parseSlashCommand } from "./slash-commands.ts";
import { runDirectTool } from "./direct-tool-runner.ts";
import { createInitialState, createTuiStore } from "./state.ts";
import { buildTerminalRenderLines } from "./terminal-render-model.ts";
import { IncrementalTerminalRenderer, resolveTerminalDisplayMode, ScrollbackTerminalRenderer } from "./incremental-renderer.ts";
import { TerminalInputController, type TerminalInputAction } from "./terminal-input-controller.ts";
import { TerminalAgentService } from "./terminal-agent-service.ts";
import { TerminalAutocompleteController } from "./terminal-autocomplete-controller.ts";
import { SubagentToolsFactory } from "./subagent-tools-factory.ts";
import { loadPlanDocument } from "../plan/index.ts";
import { loadGlobalConcurrencyLimitFromEnv, loadGlobalTokenBudgetFromEnv } from "../runtime/limits.ts";
import { isTuiFeatureEnabled } from "./execution-policy.ts";
import { loadThinkingModeFromEnv } from "../thinking-policy.ts";
import { addPendingImage, handlePasteImage } from "./image-handler.ts";
import { loadImageAttachment } from "./image-attachments.ts";
import { formatCopyResultNotice, parseCopyCommand, resolveCopyTarget } from "./copy-text.ts";
import { writeClipboardText } from "./clipboard.ts";
import { finalizeExecCapture, finalizePlanCapture, parsePlanTurnOverride } from "./plan-commands.ts";
import { SessionStore, type PersistedSession, type PersistedSessionMeta } from "../session-store.ts";
import { SessionManager } from "../session-manager.ts";
import type { AgentMessage } from "../types.ts";
import { formatAmbiguousSessionNotice, getStartupSessionRequest, parseResumeCommand, resolveSessionByPrefix, restoreLlmConfig, restoreTuiSession, toPersistedTodos } from "./session-serialization.ts";
import { adaptHistoryForModel } from "../message-adapter.ts";
import { activateProfile, listProfiles, loadProfileStore, removeProfile, saveProfile } from "../profile-store.ts";
import { parseModelCommand, shouldSubmitTypedModelCommand } from "./model-command.ts";
import { isExactSlashCommand } from "./autocomplete.ts";
import { TUI_BRAND_NAME, TUI_BRAND_VERSION } from "./brand.ts";
import type { RuntimeExecutionContext } from "../runtime/policy-types.ts";
import { createPiTuiRuntime, type PiTuiRuntime } from "./pi-tui-runtime.ts";

const ALTERNATE_SCREEN = "\x1b[?1049h";
const MAIN_SCREEN = "\x1b[?1049l";

/**
 * Claude Code-style standalone ANSI entrypoint. The reducer, Agent service,
 * permission flow, autocomplete, and session store remain shared with Ink;
 * only the terminal layout and row-level output path live here.
 */
export async function runTerminalMain(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("TUI requires an interactive terminal");
  }

  const cwd = process.cwd();
  let activeLlm = loadLlmConfigFromEnv();
  let activeThinkingMode = loadThinkingModeFromEnv();
  const vision = loadVisionConfigFromEnv();
  const autoSubagent = loadAutoSubagentOptionsFromEnv();
  await discoverWorkspaceSkills(cwd).catch(() => undefined);
  let activeSkillNames = loadSkillNamesFromEnv();
  const store = createTuiStore(createInitialState(activeLlm.model));
  const permissionManager = new PermissionManager("plan");
  const startup = getStartupSessionRequest();
  const startupSessionId = startup.sessionId;
  const sessionManager = new SessionManager({
    workspaceId: cwd,
  });
  let activeSessionId = sessionManager.sessionId;
  const sessionRef = { current: activeSessionId };
  let initialHistory: AgentMessage[] = createAgentHistory(undefined, permissionManager.getMode());
  let restoredSession: PersistedSession | undefined;
  try {
    let target: PersistedSession | undefined;
    const startupSelection = startup.resume
      ? resolveSessionByPrefix(
          await sessionManager.list(),
          startupSessionId ?? "",
        )
      : { candidates: [] };
    if (!startupSelection.session && startupSelection.candidates.length > 1) {
      store.dispatch({
        type: "ADD_NOTICE",
        title: "恢复会话",
        text: formatAmbiguousSessionNotice(startupSessionId ?? "", startupSelection.candidates),
      });
    }
    target = startupSelection.session
      ? await sessionManager.load(startupSelection.session.id)
      : undefined;
    if (target && startup.fork) target = await sessionManager.fork(target.id);
    if (target && target.messages.length > 0) {
      restoredSession = target;
      activeSessionId = target.id;
      sessionRef.current = target.id;
      sessionManager.setSessionId(target.id);
      const mode = target.permissionMode ?? permissionManager.getMode();
      permissionManager.setMode(mode);
      activeLlm = restoreLlmConfig(activeLlm, target);
      if (target.thinkingMode) activeThinkingMode = target.thinkingMode;
      if (target.skillNames) activeSkillNames = [...target.skillNames];
      const baseHistory = createAgentHistory(undefined, mode);
      const systemPrompt = typeof baseHistory[0]?.content === "string" ? baseHistory[0].content : "";
      const restoredState = restoreTuiSession(
        target,
        systemPrompt,
        (session, prompt) => sessionManager.restoreHistory(session, prompt),
      );
      initialHistory = restoredState.history;
      store.dispatch({
        type: "RESTORE_SESSION",
        history: initialHistory,
        permissionMode: mode,
        modelName: activeLlm.model,
        thinkingMode: target.thinkingMode === "adaptive" ? "hidden" : "summary",
        phase: target.phase,
        currentPlan: target.currentPlan,
        todos: restoredState.todos,
        todoRevision: restoredState.todoRevision,
      });
    }
  } catch {
    // Session resume is best-effort and must never prevent the TUI from starting.
  }
  const planCaptureRef: { current: { prompt: string } | null } = { current: null };
  const execCaptureRef: { current: { mode: "run" | "retry" } | null } = { current: null };
  const parentRuntime: AgentRuntimeRef = {};
  const runtimeContext: RuntimeExecutionContext = { sessionId: activeSessionId, workspaceId: cwd };
  let activePermissionTurn: import("../permissions.ts").PermissionTurnContext | undefined;
  let sandboxRunner: Awaited<ReturnType<typeof createSandboxRunner>> | undefined;
  const codebaseRuntime = createCodebaseRuntimeFromEnv();
  const mcpRuntime = await createMcpRuntimeFromEnv(cwd).catch(async (error) => {
    await codebaseRuntime.close();
    throw error;
  });

  try {
    const sandboxEnabled = process.env.MINI_AGENT_SANDBOX !== "0" && process.env.MINI_AGENT_SANDBOX !== "false";
    if (sandboxEnabled) {
      try {
        sandboxRunner = await createSandboxRunner({
          enabled: true,
          type: (process.env.MINI_AGENT_SANDBOX_TYPE as "auto" | "docker" | "node" | "none" | undefined) ?? "auto",
          dockerImage: process.env.MINI_AGENT_SANDBOX_IMAGE,
          allowNetwork: process.env.MINI_AGENT_SANDBOX_NETWORK === "true",
          cpuLimit: process.env.MINI_AGENT_SANDBOX_CPUS ? Number.parseFloat(process.env.MINI_AGENT_SANDBOX_CPUS) : undefined,
          memoryLimit: process.env.MINI_AGENT_SANDBOX_MEMORY,
          timeout: process.env.MINI_AGENT_SANDBOX_TIMEOUT ? Number.parseInt(process.env.MINI_AGENT_SANDBOX_TIMEOUT, 10) : undefined,
        });
      } catch (error) {
        process.stderr.write(`[sandbox] failed to initialize: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }

    const baseTools = mcpRuntime.toolProvider(createTools(cwd, {
      codebase: process.env.EXTERNAL_CODEBASE_ENABLED !== "0",
      codebaseStore: codebaseRuntime.store,
      codebaseProvider: codebaseRuntime.semanticProvider,
      sandboxRunner,
    }));
    const allTools = mcpRuntime.toolProvider(createAllTools(cwd, { sandboxRunner }));
    const subagentFactory = new SubagentToolsFactory();
    const parentTools = () => [
      ...resolveToolProvider(baseTools),
      ...subagentFactory.getTools({
        parentLlm: activeLlm,
        parentTools: baseTools,
        visionPreprocessors: vision ? [createVisionPreprocessor(vision)] : [],
        onSubagentEvent: (event) => store.dispatch({ type: "SUBAGENT_EVENT", event }),
        getPermissionTurn: () => activePermissionTurn,
        parentRuntime,
        globalTokenBudget: loadGlobalTokenBudgetFromEnv(),
        globalConcurrencyLimit: loadGlobalConcurrencyLimitFromEnv(),
      }),
    ];
    const persistSessionSnapshot = async (history: AgentMessage[]): Promise<void> => {
      try {
        const state = store.getState();
        await sessionManager.save({
          id: sessionRef.current,
          modelId: activeLlm.model,
          thinkingLevel: activeLlm.thinkingLevel,
          thinkingMode: activeThinkingMode,
          permissionMode: permissionManager.getMode(),
          skillNames: activeSkillNames,
          phase: state.phase,
          currentPlan: state.currentPlan,
          messages: history,
          todos: toPersistedTodos(state.todoItems),
          todoVersion: state.todoRevision,
        });
      } catch {
        // Persistence is best-effort; a disk error must not break chat.
      }
    };

    const service = new TerminalAgentService({
      store,
      llm: activeLlm,
      tools: parentTools,
      permissionManager,
      getPermissionSessionId: () => sessionRef.current,
      autoSubagent,
      preprocessors: vision ? [createVisionPreprocessor(vision)] : [],
      runtimeRef: parentRuntime,
      history: initialHistory,
      runtimeContext,
      globalTokenBudget: loadGlobalTokenBudgetFromEnv(),
      cwd,
      thinkingMode: activeThinkingMode,
      autoValidate: isTuiFeatureEnabled(process.env.MINI_AGENT_AUTO_VALIDATE),
      autoCheckpoint: isTuiFeatureEnabled(process.env.MINI_AGENT_AUTO_CHECKPOINT),
      skillNames: activeSkillNames,
      skillRegistry: defaultSkillRegistry,
      sessionId: activeSessionId,
      onLlmChange: (llm) => { activeLlm = llm; },
      onPermissionTurnChange: (turn) => { activePermissionTurn = turn; },
      onTurnStarted: async ({ history }) => persistSessionSnapshot(history),
      onTurnFinished: async (result) => {
        await finalizePlanCapture({
          cwd,
          planCaptureRef,
          history: result.history,
          succeeded: result.succeeded,
          dispatch: store.dispatch,
        });
        await finalizeExecCapture({
          cwd,
          execCaptureRef,
          history: result.history,
          succeeded: result.succeeded,
          errorMessage: result.errorMessage,
          dispatch: store.dispatch,
        });
        if (result.history.length <= 1) return;
        await persistSessionSnapshot(result.history);
      },
    });

    // A persisted session's Todo snapshot is newer than the workspace plan;
    // only fall back to the file-backed plan when no session Todo exists.
    if (!restoredSession?.todos?.length) {
      await loadPlanDocument(cwd)
        .then((plan) => { if (plan) store.dispatch({ type: "SET_TODO_PLAN", plan }); })
        .catch(() => undefined);
    }
    if (restoredSession) {
      store.dispatch({ type: "ADD_NOTICE", title: "会话已恢复", text: `${activeSessionId.slice(0, 8)} · ${restoredSession.messages.length} 条消息` });
    }

    const displayMode = resolveTerminalDisplayMode();
    let usePiTui = displayMode === "pi";
    let scrollback = displayMode === "scrollback";
    let fullscreen = displayMode === "fullscreen";
    const scrollbackRenderer = new ScrollbackTerminalRenderer(process.stdout);
    let renderer: IncrementalTerminalRenderer | ScrollbackTerminalRenderer = fullscreen
      ? new IncrementalTerminalRenderer(process.stdout)
      : scrollbackRenderer;
    let piRuntime: PiTuiRuntime | undefined;
    // Existing scrollback rows cannot be reflowed after they have been handed
    // to the terminal, so keep the initial width for the append-only path.
    const scrollbackWidth = process.stdout.columns || 80;
    let autocomplete: TerminalAutocompleteController;
    let render: () => void = () => undefined;
    let animationTimer: ReturnType<typeof setInterval> | undefined;
    const directAbortRef: { current?: AbortController } = {};
    const input = new TerminalInputController({
      onAction: (action) => handleInputAction(action, { store, service, permissionManager, input, cwd, planCaptureRef, execCaptureRef, autocomplete, sessionAccess: sessionManager, sessionRef, allTools, runtimeContext, directAbortRef, setThinkingMode: (mode) => { activeThinkingMode = mode; service.setThinkingMode(mode); }, persistSession: persistSessionSnapshot, onSessionRestore: () => { if (scrollback) scrollbackRenderer.forceNewSegment(); } }),
      getScrollPageSize: () => Math.max(1, (process.stdout.rows || 24) - 8),
    });
    autocomplete = new TerminalAutocompleteController({
      cwd,
      getInput: () => input.getValue(),
      setInput: (value) => {
        input.setValue(value);
        autocomplete.update(value);
        render();
      },
      listSessionIds: async () => (await sessionManager.list()).map((session) => session.id),
      listSessions: () => sessionManager.list(),
      onChange: () => render(),
    });
    // Cache last rendered result to avoid double-buildTerminalRenderLines on every
    // scroll frame, and to skip re-renders when the state hasn't changed.
    let frameCache: { stateVersion: number; naturalLines: readonly import("./render-lines.ts").RenderLine[]; scrollOffset: number; lines: readonly import("./render-lines.ts").RenderLine[] } | undefined;
    const buildFrameLines = (width: number, height: number): ReturnType<typeof buildTerminalRenderLines> => {
      const state = store.getState();
      const renderOptions = {
        width,
        ...(fullscreen || usePiTui ? {
          scrollOffset: state.scrollOffset,
        } : {
          scrollback: true,
        }),
        // Keep the product identity pinned above the transcript, including
        // restored sessions and active turns.
        header: {
          title: TUI_BRAND_NAME,
          cwd,
          version: TUI_BRAND_VERSION,
          model: `${service.getLlm().provider}/${service.getLlm().model}`,
          billing: "API Usage Billing",
          // Scrollback keeps the welcome frame as the first committed
          // transcript segment; alternate-screen views condense it after the
          // first turn.
          showWelcome: scrollback || (state.messages.length === 0 && !state.busy && !state.pendingPermission),
        },
        promptRule: true,
        input: input.getValue(),
        cursor: input.getCursor(),
        autocomplete: autocomplete.getState(),
        maskInput: autocomplete.getState().mode === "model-setup" && autocomplete.getState().modelSetup?.field === "apiKey",
        now: Date.now(),
        contextWindow: service.getLlm().contextWindow,
        queuedCount: service.getQueuedCount(),
        thinkingLevel: service.getLlm().thinkingLevel,
      };
      // Scrollback mode: no frame height cap, no double-build.
      if (scrollback) {
        frameCache = undefined;
        return buildTerminalRenderLines(state, renderOptions);
      }

      const frameHeight = usePiTui ? Math.max(1, height) : Math.max(1, height - 1);
      const scrollOffset = state.scrollOffset;

      // Reuse cached naturalLines unless state or viewport changed.
      if (
        !frameCache
        || frameCache.stateVersion !== state.revision
        || frameCache.scrollOffset !== scrollOffset
        || frameCache.lines.length !== frameHeight
      ) {
        const naturalLines = buildTerminalRenderLines(state, renderOptions);
        const lines = naturalLines.length > frameHeight
          ? naturalLines.slice(scrollOffset, scrollOffset + frameHeight)
          : naturalLines;
        frameCache = { stateVersion: state.revision, naturalLines, scrollOffset, lines };
      }
      return frameCache.lines;
    };
    if (usePiTui) {
      try {
        piRuntime = await createPiTuiRuntime(buildFrameLines, (data) => input.handle(data));
      } catch {
        // pi-tui uses newer runtime syntax than the historical TUI path. Keep
        // the app usable on older Node versions with the stable fullscreen
        // renderer rather than failing during module evaluation.
        piRuntime = undefined;
        usePiTui = false;
        scrollback = false;
        fullscreen = true;
        renderer = new IncrementalTerminalRenderer(process.stdout);
      }
    }
    // Throttle render() to once per animation frame to avoid stacking
    // intermediate frames during fast scroll or streaming updates.
    let renderQueued = false;
    render = () => {
      if (renderQueued) return;
      renderQueued = true;
      const flush = () => {
        renderQueued = false;
        if (!screenActive || quitting) return;
        if (piRuntime) {
          piRuntime.tui.requestRender();
          return;
        }
        const width = fullscreen ? process.stdout.columns || 80 : scrollbackWidth;
        renderer.renderLines(buildFrameLines(width, process.stdout.rows || 24));
      };
      // requestAnimationFrame exists in browsers; in Node, schedule via setImmediate(0)
      // which yields to I/O and avoids blocking the event loop.
      const raf = typeof globalThis.requestAnimationFrame === "function"
        ? globalThis.requestAnimationFrame.bind(globalThis)
        : (cb: () => void) => setImmediate(cb);
      raf(flush);
    };
    const syncAnimation = () => {
      const shouldAnimate = store.getState().busy || Boolean(store.getState().pendingPermission);
      if (shouldAnimate && !animationTimer) {
        animationTimer = setInterval(() => {
          if (screenActive && !quitting) render();
        }, 120);
      } else if (!shouldAnimate && animationTimer) {
        clearInterval(animationTimer);
        animationTimer = undefined;
      }
    };
    const unsubscribe = store.subscribe(() => {
      syncAnimation();
      render();
    });
    let screenActive = false;
    let quitting = false;
    let finishLoop: () => void = () => undefined;
    const cleanup = () => {
      if (!screenActive) return;
      screenActive = false;
      if (animationTimer) clearInterval(animationTimer);
      animationTimer = undefined;
      if (piRuntime) {
        piRuntime.tui.stop();
        process.stdout.write(MAIN_SCREEN);
      } else {
        process.stdin.removeAllListeners("data");
        process.stdout.removeListener("resize", render);
        if (process.stdin.isRaw) process.stdin.setRawMode(false);
        process.stdin.pause();
      }
      if (fullscreen) {
        process.stdout.write(`\x1b[?25h${MAIN_SCREEN}`);
      } else if (scrollback) {
        // Scrollback mode never entered the alternate buffer. The renderer
        // already left the cursor after the live tail; just restore it.
        scrollbackRenderer.finish();
      }
      unsubscribe();
      finishLoop();
    };
    const quit = async () => {
      if (quitting) return;
      quitting = true;
      service.abort();
      await service.waitForIdle();
      cleanup();
    };

    if (piRuntime || fullscreen) {
      process.stdout.write(`${ALTERNATE_SCREEN}\x1b[?25l\x1b[H`);
    } else {
      // Start a clean transcript row in the user's main screen. Do not clear
      // the terminal: previous shell output must remain in scrollback.
      process.stdout.write("\x1b[2K\r\x1b[?25l");
    }
    screenActive = true;
    process.once("SIGINT", quit);
    process.once("exit", cleanup);
    syncAnimation();
    if (piRuntime) {
      piRuntime.tui.start();
    } else {
      process.stdin.setRawMode(true);
      process.stdin.setEncoding("utf8");
      process.stdin.resume();
      process.stdin.on("data", (chunk: string) => {
        input.handle(chunk);
        // An action such as /exit can synchronously tear down the screen while
        // handling the same input chunk. Do not render a fresh scrollback
        // segment after cleanup has already returned control to the shell.
        if (screenActive && !quitting) render();
      });
      process.stdout.on("resize", render);
    }
    render();

    // Keep the promise alive until the user exits. `stdin` is paused by
    // cleanup, so this does not create a second conversation loop.
    await new Promise<void>((resolve) => {
      finishLoop = resolve;
      process.stdin.once("close", resolve);
    });
    await quit();
  } finally {
    await Promise.all([mcpRuntime.close(), codebaseRuntime.close(), sandboxRunner?.cleanup() ?? Promise.resolve()]);
  }
}

export type InputDeps = {
  store: ReturnType<typeof createTuiStore>;
  service: TerminalAgentService;
  permissionManager: PermissionManager;
  input: TerminalInputController;
  cwd: string;
  planCaptureRef: { current: { prompt: string } | null };
  execCaptureRef: { current: { mode: "run" | "retry" } | null };
  autocomplete: TerminalAutocompleteController;
  /** Preferred session boundary used by the production terminal entrypoint. */
  sessionAccess?: SessionAccess;
  /** Legacy fallback kept for callers/tests that construct InputDeps directly. */
  sessionStore?: SessionStore;
  sessionManager?: SessionManager;
  sessionRef: { current: string };
  allTools: ToolProvider;
  runtimeContext: RuntimeExecutionContext;
  directAbortRef: { current?: AbortController };
  setThinkingMode: (mode: "fixed" | "adaptive") => void;
  /** Persist the transcript immediately after a model switch. */
  persistSession?: (history: AgentMessage[]) => Promise<void>;
  /** Called when a session restore resets the transcript so the renderer can
   *  flush stale committed rows before the new content is rendered. */
  onSessionRestore?: () => void;
};

export type SessionAccess = {
  list(): Promise<PersistedSessionMeta[]>;
  load(sessionId: string): Promise<PersistedSession | undefined>;
  newSession(): string;
  setSessionId(sessionId: string): void;
  restoreHistory(session: PersistedSession, systemPrompt: string): AgentMessage[];
};

function getSessionAccess(deps: InputDeps): SessionAccess {
  if (deps.sessionAccess) return deps.sessionAccess;
  if (deps.sessionManager) return deps.sessionManager;
  if (!deps.sessionStore) throw new Error("A session access implementation is required");
  return {
    list: () => deps.sessionStore!.listSessions(),
    load: (sessionId) => deps.sessionStore!.load(sessionId),
    newSession: () => randomUUID(),
    setSessionId: () => undefined,
    restoreHistory: (session, systemPrompt) => restoreTuiSession(session, systemPrompt).history,
  };
}

export function handleInputAction(action: TerminalInputAction, deps: InputDeps): void {
  const { store, service, permissionManager, input, cwd } = deps;
  const state = store.getState();
  if (action.type === "exit") {
    service.abort();
    deps.directAbortRef.current?.abort();
    process.emit("SIGINT");
    return;
  }
  if (action.type === "cancel") {
    if (deps.autocomplete.getState().mode || deps.autocomplete.getState().argumentPrefix) {
      deps.autocomplete.handleKey({ escape: true });
      if (deps.autocomplete.getState().argumentPrefix) deps.autocomplete.clear();
      return;
    }
    if (state.pendingPermission) {
      service.resolvePermission("deny");
    } else if (state.busy) {
      service.abort();
      deps.directAbortRef.current?.abort();
      store.dispatch({ type: "CANCEL_GENERATION" });
    }
    return;
  }
  if (action.type === "insert" || action.type === "backspace" || action.type === "cursor") {
    if (state.pendingPermission) {
      const last = action.type === "insert" ? action.value.slice(-1).toLowerCase() : "";
      if (last === "a" || last === "d") {
        input.clear();
        service.resolvePermission(last === "a" ? "allow" : "deny");
      } else {
        input.clear();
      }
      return;
    }
    if (action.type === "insert" && !state.busy && !deps.autocomplete.getState().mode && state.phase === "review" && state.currentPlan) {
      const last = action.value.slice(-1);
      if (last === "a" || last === "A") {
        input.clear();
        store.dispatch({ type: "APPROVE_PLAN", planId: state.currentPlan.id });
        void submitInput("/plan-approve", deps);
        return;
      }
      if (last === "r" || last === "R") {
        input.clear();
        store.dispatch({ type: "REJECT_PLAN", planId: state.currentPlan.id });
        void submitInput("/plan-reject", deps);
        return;
      }
    }
    if (action.type === "insert" || action.type === "backspace") deps.autocomplete.update(input.getValue());
    else if (action.type === "cursor" && action.direction === "right" && deps.autocomplete.handleKey({ rightArrow: true })) return;
    else if (action.type === "cursor" && action.direction === "up" && deps.autocomplete.handleKey({ upArrow: true })) return;
    else if (action.type === "cursor" && action.direction === "down" && deps.autocomplete.handleKey({ downArrow: true })) return;
    else if (action.type === "cursor" && (action.direction === "up" || action.direction === "down")) {
      if (!input.hasNewline() && input.navigateHistory(action.direction === "up" ? -1 : 1)) return;
      if (!input.moveVertical(action.direction === "up" ? -1 : 1)) {
        store.dispatch({ type: "SCROLL_BY", delta: action.direction === "up" ? 1 : -1 });
      }
    }
    return;
  }
  if (action.type === "tab") {
    if (!deps.autocomplete.handleKey({ tab: true })) deps.autocomplete.handleTab();
    return;
  }
  if (action.type === "scroll") {
    if (action.delta === 1 && deps.autocomplete.handleKey({ upArrow: true })) return;
    if (action.delta === -1 && deps.autocomplete.handleKey({ downArrow: true })) return;
    store.dispatch({ type: "SCROLL_BY", delta: action.delta });
    return;
  }
  if (action.type === "shortcut") {
    handleShortcut(action, deps);
    return;
  }
  if (action.type === "submit") {
    if (state.pendingPermission) {
      service.resolvePermission("deny");
      input.clear();
      return;
    }
    const autocompleteState = deps.autocomplete.getState();
    if (state.busy && autocompleteState.mode && autocompleteState.mode !== "file") {
      input.clear();
      deps.autocomplete.clear();
      store.dispatch({ type: "ADD_NOTICE", title: "正在执行", text: "当前 turn 完成后再切换模型或配置文件。普通消息仍会排队。" });
      return;
    }
    if (autocompleteState.mode === "session-list") {
      const selected = autocompleteState.sessions[autocompleteState.index];
      if (!selected && autocompleteState.sessionLoading) return;
      const command = selected
        ? `/resume ${selected.id}`
        : action.value;
      deps.autocomplete.clear();
      void submitInput(command, deps, selected, autocompleteState.sessions);
      return;
    }
    // Sticky overlays own Enter. Keep their state intact until the async
    // handler consumes the field (model setup or profile activation).
    if (autocompleteState.mode === "model-setup"
      || autocompleteState.mode === "profile-name"
      || autocompleteState.mode === "profile-list") {
      void submitInput(action.value, deps);
      return;
    }
    if (autocompleteState.mode === "command") {
      const selected = autocompleteState.commands[autocompleteState.index];
      if (!selected || !isExactSlashCommand(action.value, selected.name, autocompleteState.argumentCandidates)) {
        deps.autocomplete.handleKey({ tab: true });
        return;
      }
    } else if (autocompleteState.mode === "file") {
      deps.autocomplete.handleKey({ tab: true });
      return;
    } else if (autocompleteState.mode === "model" || autocompleteState.mode === "model-picker") {
      if (!shouldSubmitTypedModelCommand(action.value)) {
        const selected = autocompleteState.models[autocompleteState.index];
        if (selected) {
          selectTerminalModel(selected, {}, deps);
          return;
        }
      }
    }
    deps.autocomplete.clear();
    void submitInput(action.value, deps);
  }
}

async function copyTerminalText(
  target: import("./copy-text.ts").CopyTarget,
  deps: InputDeps,
): Promise<void> {
  const state = deps.store.getState();
  const selection = resolveCopyTarget({
    messages: state.messages,
    focusedIndex: state.focusedMessageIndex,
    streamingText: state.streamingText,
    streamingReasoning: state.streamingReasoning,
    input: deps.input.getValue(),
    target,
  });
  if (!selection) {
    deps.store.dispatch({ type: "ADD_NOTICE", title: "复制", text: "没有可复制的原文。可用 /copy last、/copy tool 或先聚焦一条消息。" });
    return;
  }
  const result = await writeClipboardText(selection.text);
  deps.store.dispatch({
    type: "ADD_NOTICE",
    title: result.ok ? "已复制到剪贴板" : "复制失败",
    text: result.ok ? formatCopyResultNotice(selection, result.method) : (result.error ?? "无法写入系统剪贴板"),
  });
}

function handleShortcut(action: Extract<TerminalInputAction, { type: "shortcut" }>, deps: InputDeps): void {
  const { store, service, permissionManager, cwd } = deps;
  const state = store.getState();
  switch (action.name) {
    case "permission": {
      const next = nextPermissionMode(permissionManager.getMode());
      switchPermissionMode(permissionManager, next);
      applyPermissionModePrompt(service.getHistory(), next);
      store.dispatch({ type: "SET_PERMISSION_MODE", mode: next });
      return;
    }
    case "thinking-level":
      if (!state.busy) {
        const direction = action.direction ?? "increase";
        const next = withThinkingLevel(service.getLlm(), cycleThinkingLevel(service.getLlm(), direction, { wrap: action.direction === undefined }));
        service.setLlm(next);
        store.dispatch({ type: "SET_STATUS", status: `思考强度: ${thinkingLevelToDisplay(next.thinkingLevel ?? "off")}` });
      }
      return;
    case "thinking-mode":
      store.dispatch({ type: "TOGGLE_THINKING_MODE" });
      return;
    case "thinking-message":
      store.dispatch({ type: "TOGGLE_MESSAGE_THINKING" });
      return;
    case "focus-message":
      if (!deps.autocomplete.getState().mode) {
        store.dispatch({ type: "FOCUS_NEXT_REASONING", direction: action.direction === "decrease" ? -1 : 1 });
      }
      return;
    case "bottom":
      store.dispatch({ type: "SCROLL_TO_BOTTOM" });
      return;
    case "copy":
      void copyTerminalText("auto", deps);
      return;
    case "paste-image":
      void handlePasteImage({
        pendingImages: state.pendingImages,
        pendingImagesRef: { current: state.pendingImages },
        dispatch: store.dispatch,
        cwd,
      });
      return;
  }
}

async function submitInput(
  value: string,
  deps: InputDeps,
  knownSession?: PersistedSessionMeta,
  knownSessions?: PersistedSessionMeta[],
): Promise<void> {
  const text = value.trim();
  const { store, service, permissionManager, input } = deps;
  const sessionAccess = getSessionAccess(deps);
  const autocompleteState = deps.autocomplete.getState();
  const allowEmptyApiKey = autocompleteState.mode === "model-setup" && autocompleteState.modelSetup?.field === "apiKey";
  const allowEmptyProfileSelection = autocompleteState.mode === "profile-list";
  if (!text && !allowEmptyApiKey && !allowEmptyProfileSelection) return;
  if (store.getState().busy && /^(?:resume|\/(?:clear|resume|model|profiles?|plan(?:-|\s|$)))/i.test(text)) {
    store.dispatch({ type: "ADD_NOTICE", title: "正在执行", text: "当前 turn 完成后才能执行该控制命令。普通消息会排队。" });
    input.clear();
    return;
  }
  if (text === "/exit" || text === "/quit") {
    service.abort();
    deps.directAbortRef.current?.abort();
    process.emit("SIGINT");
    return;
  }
  if (text === "/clear") {
    service.resetHistory(permissionManager.getMode());
    deps.sessionRef.current = sessionAccess.newSession();
    service.setSessionId(deps.sessionRef.current);
    deps.runtimeContext.sessionId = deps.sessionRef.current;
    store.dispatch({ type: "RESET" });
    input.clear();
    return;
  }
  if (text === "/sessions") {
    const sessions = knownSessions ?? await sessionAccess.list().catch(() => []);
    store.dispatch({
      type: "ADD_NOTICE",
      title: "会话列表",
      text: sessions.length === 0
        ? "没有可恢复的会话。"
        : sessions.slice(0, 8).map((session) => `${session.id.slice(0, 8)}  ${session.messageCount} 条  ${session.preview}`).join("\n"),
    });
    input.clear();
    return;
  }
  if (autocompleteState.mode === "model-setup" && autocompleteState.modelSetup) {
    await submitModelSetup(text, deps);
    return;
  }
  if (autocompleteState.mode === "profile-name" && autocompleteState.pendingProfileSetup) {
    const setup = autocompleteState.pendingProfileSetup;
    const profileName = text || "default";
    try {
      await saveProfile(profileName, {
        model: `${setup.model.provider}/${setup.model.id}`,
        baseUrl: setup.baseUrl,
        apiKey: setup.apiKey,
        thinkingLevel: deps.service.getLlm().thinkingLevel,
      });
      store.dispatch({ type: "ADD_NOTICE", title: "配置文件已保存", text: profileName });
    } catch (error) {
      store.dispatch({ type: "ADD_NOTICE", title: "配置文件", text: error instanceof Error ? error.message : String(error) });
      return;
    }
    deps.autocomplete.clear();
    input.clear();
    return;
  }
  if (autocompleteState.mode === "profile-list" && autocompleteState.profileListState) {
    await activateTerminalProfile(autocompleteState.profileListState.selectedIndex, deps);
    return;
  }
  if (/^\/profiles?\s+delete\s+/i.test(text)) {
    const name = text.replace(/^\/profiles?\s+delete\s+/i, "").trim();
    try {
      await removeProfile(name);
      store.dispatch({ type: "ADD_NOTICE", title: "配置文件", text: `已删除配置文件: ${name}` });
    } catch (error) {
      store.dispatch({ type: "ADD_NOTICE", title: "配置文件", text: error instanceof Error ? error.message : String(error) });
    }
    input.clear();
    return;
  }
  if (/^\/profiles?$/i.test(text)) {
    await openTerminalProfileList(deps);
    return;
  }
  if (/^\/model(?:\s+.*)?$/i.test(text)) {
    const parsed = parseModelCommand(text.replace(/^\/model\s*/i, ""));
    if (!parsed.reference) {
      deps.autocomplete.openModelPicker();
      input.setValue("/model ");
      return;
    }
    selectTerminalModel(parsed.reference, parsed.overrides, deps);
    input.clear();
    return;
  }
  if (text === "/context") {
    const current = store.getState();
    store.dispatch({ type: "ADD_NOTICE", title: "上下文统计", text: `上下文: ${current.contextTokens} tokens · 本轮输出: ${current.usedTokens} tokens` });
    input.clear();
    return;
  }
  const copyTarget = parseCopyCommand(text);
  if (copyTarget) {
    input.clear();
    await copyTerminalText(copyTarget, deps);
    return;
  }
  if (/^\/paste-image$/i.test(text)) {
    input.clear();
    const pendingImages = store.getState().pendingImages;
    await handlePasteImage({
      pendingImages,
      pendingImagesRef: { current: pendingImages },
      dispatch: store.dispatch,
      cwd: deps.cwd,
    });
    return;
  }
  const imageMatch = text.match(/^\/image\s+(.+)$/i);
  if (imageMatch) {
    const imagePath = imageMatch[1]!.trim();
    input.clear();
    if (imagePath.toLowerCase() === "clear") {
      store.dispatch({ type: "CLEAR_PENDING_IMAGES" });
      return;
    }
    try {
      const image = await loadImageAttachment(imagePath, deps.cwd);
      const pendingImages = store.getState().pendingImages;
      addPendingImage(image, {
        pendingImages,
        pendingImagesRef: { current: pendingImages },
        dispatch: store.dispatch,
        cwd: deps.cwd,
      });
    } catch (error) {
      store.dispatch({ type: "ATTACHMENT_ERROR", message: `无法添加图片: ${error instanceof Error ? error.message : String(error)}` });
    }
    return;
  }
  const skillCommand = applySkillCommand(text, deps.service.getSkillNames());
  if (skillCommand) {
    deps.service.setSkillNames(skillCommand.activation.activeNames);
    store.dispatch({ type: "ADD_NOTICE", title: "Skills", text: skillCommand.message });
    input.clear();
    return;
  }
  if (text === "/help" || text === "/?") {
    store.dispatch({ type: "ADD_NOTICE", title: "Available commands", text: "Type / for the command palette; Tab/↑↓ select; Shift+Tab changes permission mode.\n/model, /profiles, /sessions, /resume, /clear, /tasks, /plan*" });
    input.clear();
    return;
  }
  const slashCommand = parseSlashCommand(text);
  if (slashCommand) {
    input.recordSubmission(text);
    input.clear();
    store.dispatch({ type: "USER_MESSAGE", text });
    const abortController = new AbortController();
    const args = slashCommand.cmd === "read" || slashCommand.cmd === "ls"
      ? { path: slashCommand.path }
      : slashCommand.cmd === "bash"
        ? { command: slashCommand.command }
        : slashCommand.cmd === "find"
          ? { pattern: slashCommand.pattern, path: slashCommand.path }
          : { pattern: slashCommand.pattern, path: slashCommand.path };
    deps.directAbortRef.current = abortController;
    try {
      const directResult = await runDirectTool(slashCommand.cmd, args, {
        allTools: deps.allTools,
        permissionSessionId: deps.sessionRef.current,
        getPermissionManager: () => permissionManager,
        abortSignal: abortController.signal,
        dispatch: store.dispatch,
      });
      await service.recordDirectToolTurn(text, directResult.call, directResult.result);
      store.dispatch({ type: "LOOP_EVENT", event: { type: "done", messages: service.getHistory() } });
    } finally {
      if (deps.directAbortRef.current === abortController) deps.directAbortRef.current = undefined;
    }
    return;
  }
  const resumeCommand = parseResumeCommand(text);
  if (resumeCommand) {
    const prefix = resumeCommand.prefix;
    const sessions = knownSession
      ? [knownSession]
      : knownSessions ?? await sessionAccess.list().catch(() => []);
    const selection = knownSession
      ? { session: knownSession, candidates: [knownSession] }
      : resolveSessionByPrefix(sessions, prefix);
    if (!selection.session && selection.candidates.length > 1) {
      store.dispatch({
        type: "ADD_NOTICE",
        title: "恢复会话",
        text: formatAmbiguousSessionNotice(prefix, selection.candidates),
      });
      input.clear();
      return;
    }
    const target = selection.session;
    if (!target) {
      store.dispatch({ type: "ADD_NOTICE", title: "恢复会话", text: prefix ? `未找到会话: ${prefix}` : "没有可恢复的会话。" });
      input.clear();
      return;
    }
    const restored = await sessionAccess.load(target.id);
    if (!restored) {
      store.dispatch({ type: "ADD_NOTICE", title: "恢复会话", text: `无法读取会话: ${target.id}` });
      input.clear();
      return;
    }
    const mode = restored.permissionMode ?? permissionManager.getMode();
    permissionManager.setMode(mode);
    const previousLlm = service.getLlm();
    let restoredLlm = previousLlm;
    if (restored.modelId && restored.modelId !== previousLlm.model) {
      try {
        restoredLlm = switchLlmModel(previousLlm, restored.modelId);
      } catch {
        // Keep the current model when a persisted profile is no longer usable.
      }
    }
    if (restored.thinkingLevel) restoredLlm = withThinkingLevel(restoredLlm, restored.thinkingLevel);
    if (restoredLlm.model !== previousLlm.model || restoredLlm.thinkingLevel !== previousLlm.thinkingLevel) {
      service.setLlm(restoredLlm);
      store.dispatch({ type: "MODEL_CHANGED", modelName: restoredLlm.model });
    }
    if (restored.skillNames) service.setSkillNames(restored.skillNames);
    if (restored.thinkingMode) deps.setThinkingMode(restored.thinkingMode);
    const baseHistory = createAgentHistory(undefined, mode);
    const systemPrompt = typeof baseHistory[0]?.content === "string" ? baseHistory[0].content : "";
    const restoredState = restoreTuiSession(restored, systemPrompt, (session, prompt) => sessionAccess.restoreHistory(session, prompt));
    service.replaceHistory(restoredState.history);
    deps.sessionRef.current = restored.id;
    sessionAccess.setSessionId(restored.id);
    service.setSessionId(restored.id);
    deps.runtimeContext.sessionId = restored.id;
    // Force the scrollback renderer to treat the next render as a new visual
    // segment so the entire restored transcript is written cleanly, rather than
    // attempting an incremental prefix diff from the pre-resume committed rows
    // which would leave stale content on screen.
    deps.onSessionRestore?.();
    store.dispatch({
      type: "RESTORE_SESSION",
      history: restoredState.history,
      permissionMode: mode,
      modelName: service.getLlm().model,
      thinkingMode: restored.thinkingMode === "adaptive" ? "hidden" : "summary",
      phase: restored.phase,
      currentPlan: restored.currentPlan,
      todos: restoredState.todos,
      todoRevision: restoredState.todoRevision,
    });
    store.dispatch({ type: "ADD_NOTICE", title: "会话已恢复", text: `${restored.id.slice(0, 8)} · ${restored.messages.length} 条消息` });
    input.clear();
    return;
  }
  const planOverride = await parsePlanTurnOverride(text, {
    cwd: deps.cwd,
    dispatch: store.dispatch,
    setInput: () => input.clear(),
    planCaptureRef: deps.planCaptureRef,
    execCaptureRef: deps.execCaptureRef,
    permissionManager,
  });
  if (planOverride === null) {
    input.clear();
    return;
  }
  if (planOverride?.forceMode && permissionManager.getMode() !== planOverride.forceMode) {
    permissionManager.setMode(planOverride.forceMode);
    store.dispatch({ type: "SET_PERMISSION_MODE", mode: planOverride.forceMode });
  }
  const todo = parseTodoCommand(text);
  if (todo) {
    if (todo === "clear") store.dispatch({ type: "CLEAR_TODO_ITEMS" });
    else store.dispatch({ type: "SET_TODO_VIEW_MODE", mode: todoViewModeForCommand(todo, store.getState().todoViewMode) });
    input.clear();
    return;
  }
  input.recordSubmission(planOverride?.displayText ?? value);
  input.clear();
  const pendingImages = planOverride ? undefined : store.getState().pendingImages;
  const resultPromise = service.submit(planOverride?.prompt ?? value, {
    ...(planOverride?.displayText !== undefined ? { displayText: planOverride.displayText } : {}),
    ...(pendingImages?.length ? { images: pendingImages } : {}),
  });
  if (pendingImages?.length) store.dispatch({ type: "CLEAR_PENDING_IMAGES" });
  const result = await resultPromise;
  if (planOverride?.restoreMode && permissionManager.getMode() !== planOverride.restoreMode) {
    permissionManager.setMode(planOverride.restoreMode);
    store.dispatch({ type: "SET_PERMISSION_MODE", mode: planOverride.restoreMode });
  }
  // The service invokes finalization hooks for captured plan turns. Keep the
  // local result referenced so future command adapters can inspect it without
  // creating a second history store.
  void result;
}

function selectTerminalModel(
  reference: string,
  overrides: { baseUrl?: string; apiKey?: string },
  deps: InputDeps,
): void {
  const match = findExactModelReferenceMatch(reference, getAllModels());
  if (match?.ambiguous) {
    deps.autocomplete.openModelPicker(reference, match.matches);
    return;
  }
  const model = match?.model ?? resolveModel(reference, overrides.baseUrl);
  const current = deps.service.getLlm();
  const providerKey = model.apiKeyEnv
    .map((name) => process.env[name])
    .find((value): value is string => Boolean(value));
  const canReuseCurrentKey = model.provider === current.provider && model.baseUrl === current.baseUrl;
  const setup = {
    model,
    baseUrl: overrides.baseUrl ?? model.baseUrl,
    apiKey: overrides.apiKey ?? (canReuseCurrentKey ? current.apiKey : providerKey ?? ""),
    field: "baseUrl" as const,
  };

  // A fully specified gateway can be applied immediately; otherwise use the
  // same two-step Base URL -> API key overlay as the Ink entrypoint.
  if (overrides.baseUrl && overrides.apiKey) {
    void applyTerminalModel(model, overrides, deps);
    return;
  }
  deps.autocomplete.openModelSetup(setup);
  deps.input.setValue(setup.baseUrl);
}

async function applyTerminalModel(
  model: Parameters<typeof switchLlmModel>[1],
  overrides: { baseUrl?: string; apiKey?: string },
  deps: InputDeps,
): Promise<boolean> {
  try {
    const previous = deps.service.getLlm();
    const next = switchLlmModel(previous, model, overrides);
    deps.service.setLlm(next);
    if (deps.service.getHistory().length > 1) {
      deps.service.replaceHistory(adaptHistoryForModel(deps.service.getHistory(), {
        targetCapabilities: next.capabilities,
        sourceCapabilities: previous.capabilities,
      }));
    }
    // Save immediately: a model switch can happen between turns, so waiting
    // for the next prompt would lose the adapted history on restart.
    await deps.persistSession?.(deps.service.getHistory());
    deps.store.dispatch({ type: "MODEL_CHANGED", modelName: next.model });
    deps.autocomplete.clear();
    deps.input.clear();
    deps.store.dispatch({ type: "ADD_NOTICE", title: "模型已切换", text: `${next.provider}/${next.model}` });
    return true;
  } catch (error) {
    deps.store.dispatch({ type: "ADD_NOTICE", title: "模型切换失败", text: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

async function submitModelSetup(value: string, deps: InputDeps): Promise<void> {
  const current = deps.autocomplete.getState();
  const setup = current.modelSetup;
  if (!setup) return;
  if (setup.field === "baseUrl") {
    const baseUrl = value.replace(/\/$/, "");
    deps.autocomplete.setModelSetup({ ...setup, baseUrl, field: "apiKey", error: undefined });
    deps.input.setValue(setup.apiKey);
    return;
  }
  try {
    const applied = await applyTerminalModel(setup.model, { baseUrl: setup.baseUrl, apiKey: value }, deps);
    if (!applied) {
      deps.autocomplete.setModelSetup({ ...setup, apiKey: value, error: "模型配置未能应用" });
      deps.input.setValue(value);
      return;
    }
    const next = deps.service.getLlm();
    const profileName = `${next.provider}-${next.model}`.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 40);
    await saveProfile(profileName, {
      model: `${next.provider}/${next.model}`,
      baseUrl: next.baseUrl,
      apiKey: next.apiKey,
      thinkingLevel: next.thinkingLevel,
      ...(next.timeoutMs !== undefined ? { timeoutMs: next.timeoutMs } : {}),
      ...(next.firstResponseTimeoutMs !== undefined ? { firstResponseTimeoutMs: next.firstResponseTimeoutMs } : {}),
      ...(next.streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs: next.streamIdleTimeoutMs } : {}),
    });
  } catch (error) {
    deps.autocomplete.setModelSetup({ ...setup, apiKey: value, error: error instanceof Error ? error.message : String(error) });
    deps.input.setValue(value);
  }
}

async function openTerminalProfileList(deps: InputDeps): Promise<void> {
  try {
    const profiles = listProfiles(await loadProfileStore());
    deps.autocomplete.openProfileList({ profiles, selectedIndex: 0 });
    deps.input.clear();
  } catch (error) {
    deps.store.dispatch({ type: "ADD_NOTICE", title: "配置文件", text: error instanceof Error ? error.message : String(error) });
  }
}

async function activateTerminalProfile(index: number, deps: InputDeps): Promise<void> {
  const profileState = deps.autocomplete.getState().profileListState;
  const selected = profileState?.profiles[index];
  if (!selected) {
    deps.autocomplete.clear();
    deps.input.clear();
    return;
  }
  try {
    await activateProfile(selected.name);
    const previous = deps.service.getLlm();
    const next = loadLlmConfigFromEnv();
    deps.service.setLlm(next);
    if (deps.service.getHistory().length > 1) {
      deps.service.replaceHistory(adaptHistoryForModel(deps.service.getHistory(), {
        targetCapabilities: next.capabilities,
        sourceCapabilities: previous.capabilities,
      }));
    }
    deps.store.dispatch({ type: "MODEL_CHANGED", modelName: next.model });
    deps.store.dispatch({ type: "ADD_NOTICE", title: "配置文件已激活", text: `${selected.name} · ${next.provider}/${next.model}` });
  } catch (error) {
    deps.store.dispatch({ type: "ADD_NOTICE", title: "配置文件", text: error instanceof Error ? error.message : String(error) });
  }
  deps.autocomplete.clear();
  deps.input.clear();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runTerminalMain().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
