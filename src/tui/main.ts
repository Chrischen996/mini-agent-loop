import process from "node:process";
import path from "node:path";
import { contentAsString } from "../content.ts";
import { loadLlmConfigFromEnv, switchLlmModel } from "../llm/index.ts";
import {
  cycleThinkingLevel,
  buildIntenseLlm,
  parseThinkingCommandMode,
  parseThinkingIntensityPrompt,
  thinkingLevelToDisplay,
  withThinkingLevel,
} from "../think-intensity.ts";
import { loadThinkingModeFromEnv } from "../thinking-policy.ts";
import type { ModelThinkingLevel } from "../pi-ai/types.ts";
import {
  createAgentHistory,
  MaxTurnsExceededError,
  runAgentTurn,
  type AgentRuntimeRef,
  type LoopEvent,
} from "../loop.ts";
import {
  createVisionPreprocessor,
  loadVisionConfigFromEnv,
} from "../preprocessors/index.ts";
import { createTools } from "../tools/index.ts";
import { createMcpRuntimeFromEnv } from "../mcp/runtime.ts";
import { createCodebaseRuntimeFromEnv } from "../codebase/runtime.ts";
import { loadPlanDocument } from "../plan/index.ts";
import { PERMISSION_MODES, PermissionManager, type PermissionMode } from "../permissions.ts";
import { isTodoRevisionNewer, nextTodoRevision, TODO_WRITE_TOOL_NAME } from "../todo.ts";
import { loadAutoSubagentOptionsFromEnv } from "../subagent/index.ts";
import { createSubagentTool, createSubagentBatchTool, defaultProfiles } from "../subagent/index.ts";
import type { SubagentEvent } from "../subagent/types.ts";
import type { RuntimeExecutionContext } from "../runtime/policy-types.ts";
import { loadGlobalConcurrencyLimitFromEnv, loadGlobalTokenBudgetFromEnv } from "../runtime/limits.ts";
import {
  applySkillCommand,
  defaultSkillRegistry,
  discoverWorkspaceSkills,
  loadSkillNamesFromEnv,
} from "../skills/index.ts";
import {
  buildLegacyCursorOutput,
  buildLegacyFrameLines,
  buildLegacyFrameOutput,
  buildLegacyFrameRowCount,
  LEGACY_ANSI,
  type LegacyTuiState,
} from "./legacy-render.ts";
import {
  finalizeExecCapture,
  finalizePlanCapture,
  parsePlanTurnOverride,
} from "./plan-commands.ts";
import { parseTodoCommand, todoViewModeForCommand } from "./todo-commands.ts";
import { getDataRoot, type PersistedSessionMeta } from "../session-store.ts";
import { SessionManager } from "../session-manager.ts";
import type { AgentMessage } from "../types.ts";
import { MemoryStore } from "../orchestration/memory-store.ts";
import { createAutoMemoryHook, isAutoMemoryEnabled } from "../memory/auto-memory.ts";
import type { TuiAction } from "./state.ts";
import { isTuiFeatureEnabled } from "./execution-policy.ts";
import { createSessionPickerState, formatAmbiguousSessionNotice, getStartupSessionRequest, moveSessionPicker, parseResumeCommand, resolveSessionByPrefix, restoreLlmConfig, restoreTuiSession, selectedSessionFromPicker, toPersistedTodos } from "./session-serialization.ts";
import { compactText } from "./text-utils.ts";
import { TUI_BRAND_VERSION } from "./brand.ts";

type TuiState = LegacyTuiState & {
  /** Stores the current pending permission request for keyboard resolution. */
  pendingPermissionRequestId?: string;
  /** Stores the current session ID for permission resolution. */
  pendingPermissionSessionId?: string;
};

let previousFrameRowCount = 0;

function render(state: TuiState): void {
  const columns = process.stdout.columns || 80;
  const lines = buildLegacyFrameLines(state, columns);
  process.stdout.write(buildLegacyFrameOutput(lines, previousFrameRowCount, columns));
  process.stdout.write(buildLegacyCursorOutput(lines, state, columns));
  previousFrameRowCount = buildLegacyFrameRowCount(lines, columns);
}

function handleEvent(state: TuiState, event: LoopEvent): void {
  switch (event.type) {
    case "todo_updated":
      if (isTodoRevisionNewer(state.todoRevision, event.revision)) {
        state.todoItems = event.todos;
        state.todoRevision = event.revision;
      }
      state.status = "Todos updated";
      break;
    case "assistant_delta":
      state.streamingText += event.text;
      state.status = "Responding…";
      break;
    case "assistant":
      state.streamingText = "";
      state.status = event.message.toolCalls?.length ? "Preparing tool…" : "";
      break;
    case "context_compacted":
      state.status = `Context compacted ${event.beforeTokens} → ${event.afterTokens} tokens`;
      break;
    case "tool_start":
      if (event.call.name === TODO_WRITE_TOOL_NAME) {
        state.status = "Updating todos…";
        break;
      }
      state.tools.push({ id: event.call.id, name: event.call.name, status: "running" });
      state.status = `Running ${event.call.name}…`;
      break;
    case "tool_end": {
      if (event.call.name === TODO_WRITE_TOOL_NAME) {
        state.status = event.result.isError ? "Todo update failed" : "Todos updated";
        break;
      }
      const current = state.tools.find((tool) => tool.id === event.call.id);
      if (current) {
        current.status = event.result.isError ? "error" : "done";
        current.preview = compactText(contentAsString(event.result.content), 100);
      }
      state.status = event.result.isError ? `${event.call.name} failed` : `${event.call.name} completed`;
      break;
    }
    case "auto_subagent":
      state.status = event.executed
        ? `Auto subagent started (${event.profile}, score=${event.score})`
        : event.shouldDelegate
          ? `Subagent delegation suggested (${event.profile}, score=${event.score})`
          : `No auto delegation (score=${event.score})`;
      break;
    case "coordinator_mode":
      state.status = event.active
        ? `Orchestration: ${event.profile} (exploration ${event.directExplorationUsed}/${event.maxDirectExploration})`
        : "Orchestration disabled";
      break;
    case "thinking_policy":
      state.status = `Adaptive thinking: ${event.level} (${event.reasons.join(", ")})`;
      state.thinkingLevel = event.level;
      break;
    case "attempt_reset":
      state.streamingText = "";
      state.status = event.reason === "stream_truncated"
        ? `Connection lost, retrying (${event.attempt})…`
        : `Incomplete reasoning, retrying (${event.attempt})…`;
      break;
    case "permission_required":
      state.status = `Waiting for permission: ${event.request.tool} (${event.request.risk})`;
      break;
    case "aborted":
      state.streamingText = "";
      state.busy = false;
      state.status = "Cancelled";
      break;
    case "done":
      state.busy = false;
      state.status = "Ready";
      break;
  }
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("TUI requires an interactive terminal");
  }

  const cwd = process.cwd();
  let activeLlm = loadLlmConfigFromEnv();
  let activeThinkingMode = loadThinkingModeFromEnv();
  const vision = loadVisionConfigFromEnv();
  const autoSubagent = loadAutoSubagentOptionsFromEnv();
  await discoverWorkspaceSkills(cwd);
  let activeSkillNames = loadSkillNamesFromEnv();

  // ── Session persistence + auto memory (Claude Code-style) ─────────────────
  const startup = getStartupSessionRequest();
  const startupSessionId = startup.sessionId;
  const sessionManager = new SessionManager({ workspaceId: cwd });
  let activeSessionId = sessionManager.sessionId;
  const memoryStore = new MemoryStore(path.join(getDataRoot(), "memory", "records.json"));
  const buildTuiHistory = async (permissionMode: PermissionMode): Promise<AgentMessage[]> => {
    const base = createAgentHistory(undefined, permissionMode);
    if (!isAutoMemoryEnabled()) return base;
    try {
      const section = await memoryStore.buildSystemMemoryPrompt();
      if (section && base[0]?.role === "system") {
        base[0] = {
          ...base[0],
          content: `${base[0].content}\n\n# Persistent Memory\n${section}\n`,
        };
      }
    } catch {
      // Memory injection is best-effort.
    }
    return base;
  };
  const persistTurn = async (history: AgentMessage[]): Promise<void> => {
    try {
      await sessionManager.save({
        id: activeSessionId,
        modelId: activeLlm.model,
        thinkingLevel: activeLlm.thinkingLevel,
        thinkingMode: activeThinkingMode,
        permissionMode: state.permissionMode,
        skillNames: activeSkillNames,
        todos: toPersistedTodos(state.todoItems),
        todoVersion: state.todoRevision,
        messages: [...history],
      });
    } catch {
      // Persistence is best-effort; never break the interactive loop.
    }
  };

  const state: TuiState = {
    history: await buildTuiHistory("plan"),
    streamingText: "",
    tools: [],
    busy: false,
    input: "",
    pendingUser: undefined,
    status: "Ready",
    permissionMode: "plan" as PermissionMode,
        thinkingLevel: activeLlm.thinkingLevel ?? (activeLlm.reasoning ? "medium" : "off"),
        thinkingMode: activeThinkingMode,
    todoPlan: (await loadPlanDocument(cwd).catch(() => null)) ?? undefined,
    todoItems: undefined,
    todoRevision: 0,
    todoViewMode: "compact",
    cwd,
    modelName: `${activeLlm.provider}/${activeLlm.model}`,
    billingLabel: "API Usage Billing",
    version: TUI_BRAND_VERSION,
    showWelcome: true,
  };

  // A normal launch starts a new session. Explicit session IDs still support
  // restoring a session for integrations and scripted launches.
  try {
    const startupSelection = startup.resume
      ? resolveSessionByPrefix(
          await sessionManager.list(),
          startupSessionId ?? "",
        )
      : { candidates: [] };
    if (!startupSelection.session && startupSelection.candidates.length > 1) {
      state.status = formatAmbiguousSessionNotice(startupSessionId ?? "", startupSelection.candidates);
    }
    const restored = startupSelection.session
      ? await sessionManager.load(startupSelection.session.id)
      : undefined;
    let restoredSession = restored;
    if (restoredSession && startup.fork) {
      restoredSession = await sessionManager.fork(restoredSession.id);
    }
    if (restoredSession && restoredSession.messages.length > 0) {
        const mode = restoredSession.permissionMode ?? state.permissionMode;
        state.permissionMode = mode;
        activeLlm = restoreLlmConfig(activeLlm, restoredSession);
        if (restoredSession.thinkingMode) activeThinkingMode = restoredSession.thinkingMode;
        state.thinkingLevel = activeLlm.thinkingLevel ?? (activeLlm.reasoning ? "medium" : "off");
        state.modelName = activeLlm.provider + "/" + activeLlm.model;
        if (restoredSession.skillNames) activeSkillNames = [...restoredSession.skillNames];
        const base = await buildTuiHistory(mode);
        const systemPrompt = typeof base[0]?.content === "string" ? base[0].content : "";
        const restoredState = restoreTuiSession(
          restoredSession,
          systemPrompt,
          (session, prompt) => sessionManager.restoreHistory(session, prompt),
        );
        state.history = restoredState.history;
      activeSessionId = restoredSession.id;
      sessionManager.setSessionId(restoredSession.id);
        state.todoItems = restoredState.todos;
        state.todoRevision = restoredState.todoRevision;
        state.showWelcome = false;
      state.status = `Session resumed ${restoredSession.id.slice(0, 8)} (${restoredSession.messages.length} messages); /clear starts over`;
    }
  } catch {
    // Resume is best-effort.
  }
  const permissionManager = new PermissionManager(state.permissionMode);
  const planCaptureRef = { current: null as { prompt: string } | null };
  const execCaptureRef = { current: null as { mode: "run" | "retry" } | null };
  const dispatchPlanAction = (action: TuiAction): void => {
    switch (action.type) {
      case "SET_TODO_PLAN":
        state.todoPlan = action.plan;
        state.todoItems = undefined;
        state.todoRevision = nextTodoRevision();
        break;
      case "SET_TODO_ITEMS":
        if (isTodoRevisionNewer(state.todoRevision, action.revision)) {
          state.todoItems = action.todos;
          state.todoRevision = action.revision;
        }
        break;
      case "CLEAR_TODO_ITEMS":
        state.todoItems = undefined;
        state.todoRevision = nextTodoRevision();
        break;
      case "SET_TODO_VIEW_MODE":
        state.todoViewMode = action.mode;
        break;
      case "SET_PERMISSION_MODE":
        state.permissionMode = action.mode;
        break;
      case "ADD_NOTICE":
        state.notice = { title: action.title, text: action.text };
        state.status = action.title ?? action.text.split("\n")[0] ?? state.status;
        break;
      default:
        break;
    }
  };
  let cursorCol = 0;   // column offset within current line of multi-line input
  let cursorRow = 0;   // which line (0-indexed) the cursor is on
  // Set up audit logging
  permissionManager.onPermissionEvent = (event) => {
    if (event.type === "request") {
      console.error(`[permission] ${event.type} tool=${event.request.tool} risk=${event.request.risk} id=${event.request.id}`);
    }
  };
  const abortController = new AbortController();
  const codebaseRuntime = createCodebaseRuntimeFromEnv();
  const mcpRuntime = await createMcpRuntimeFromEnv(cwd).catch(async (error) => {
    await codebaseRuntime.close();
    throw error;
  });
  let tools;
  const parentRuntime: AgentRuntimeRef = {};
  const runtimeContext: RuntimeExecutionContext = {
    sessionId: activeSessionId,
    workspaceId: cwd,
  };
  const globalTokenBudget = loadGlobalTokenBudgetFromEnv();
  const globalConcurrencyLimit = loadGlobalConcurrencyLimitFromEnv();
  try {
    const baseTools = mcpRuntime.toolProvider(createTools(cwd, {
      codebase: process.env.EXTERNAL_CODEBASE_ENABLED !== "0",
      codebaseStore: codebaseRuntime.store,
      codebaseProvider: codebaseRuntime.semanticProvider,
    }));
    // Build subagent tool with current thinking mode
    const subagentTool = createSubagentTool({
      parentLlm: activeLlm,
      parentTools: baseTools,
      profiles: defaultProfiles,
      preprocessors: vision ? [createVisionPreprocessor(vision)] : [],
      onSubagentEvent: (event: SubagentEvent) => {
        if (event.type === "subagent_start") {
          state.status = `Subagent started: ${event.task.slice(0, 60)}…`;
          render(state);
        } else if (event.type === "subagent_end") {
          state.status = event.success ? "Subagent done" : "Subagent failed";
          render(state);
        }
      },
      parentRuntime,
      globalTokenBudget,
      globalConcurrencyLimit,
    });
    const subagentBatchTool = createSubagentBatchTool({
      parentLlm: activeLlm,
      parentTools: baseTools,
      profiles: defaultProfiles,
      preprocessors: vision ? [createVisionPreprocessor(vision)] : [],
      onSubagentEvent: (event: SubagentEvent) => {
        if (event.type === "subagent_start") {
          state.status = `Subagent started: ${event.task.slice(0, 60)}…`;
          render(state);
        } else if (event.type === "subagent_end") {
          state.status = event.success ? "Subagent done" : "Subagent failed";
          render(state);
        }
      },
      parentRuntime,
      globalTokenBudget,
      globalConcurrencyLimit,
    });
    tools = () => [
      ...baseTools(),
      subagentTool as import("../tools/types.ts").Tool,
      subagentBatchTool as import("../tools/types.ts").Tool,
    ];
    tools();
  } catch (error) {
    await Promise.all([mcpRuntime.close(), codebaseRuntime.close()]);
    throw error;
  }
  let screenActive = false;

  const cleanup = () => {
    if (!screenActive) return;
    screenActive = false;
    if (process.stdin.isRaw) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(`\x1b[?25h${LEGACY_ANSI.mainScreen}`);
    previousFrameRowCount = 0;
  };
  const quit = () => {
    abortController.abort();
    cleanup();
    void Promise.all([mcpRuntime.close(), codebaseRuntime.close()]).finally(() => process.exit(0));
  };

  const adjustThinkingLevel = (direction: "increase" | "decrease", wrap = false) => {
    if (state.busy) return;
    activeLlm = withThinkingLevel(activeLlm, cycleThinkingLevel(activeLlm, direction, { wrap }));
    state.thinkingLevel = activeLlm.thinkingLevel ?? (activeLlm.reasoning ? "medium" : "off");
    state.status = `Thinking level: ${state.thinkingLevel}`;
    render(state);
  };

  process.stdout.write(`${LEGACY_ANSI.alternateScreen}\x1b[?25l`);
  screenActive = true;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.on("SIGINT", quit);
  process.on("exit", cleanup);

  const openSessionPicker = async (command: "resume" | "sessions"): Promise<void> => {
    const picker = createSessionPickerState(command);
    state.sessionPicker = picker;
    state.input = "";
    state.status = "Loading session…";
    render(state);
    const sessions = await sessionManager.list().catch(() => []);
    // Escape or another picker action may have replaced the loading state.
    if (state.sessionPicker !== picker) return;
    state.sessionPicker = { ...picker, sessions, loading: false };
    state.status = "Ready";
    render(state);
  };

  const submit = async (prompt: string, knownSession?: PersistedSessionMeta) => {
    const text = prompt.trim();
    if (!text || state.busy) return;
    if (text === "/exit" || text === "/quit") return quit();
    if (text === "/clear") {
      activeSessionId = sessionManager.newSession();
      runtimeContext.sessionId = activeSessionId;
      state.history = await buildTuiHistory(state.permissionMode);
      state.tools = [];
      state.status = "Conversation cleared";
      state.todoItems = undefined;
      state.todoRevision = nextTodoRevision();
      state.showWelcome = true;
      render(state);
      return;
    }
    if (text === "/sessions") {
      await openSessionPicker("sessions");
      return;
    }
    const resumeCommand = parseResumeCommand(text);
    if (resumeCommand) {
      const arg = resumeCommand.prefix;
      if (!arg) {
        await openSessionPicker("resume");
        return;
      }
      const metas = knownSession
        ? [knownSession]
        : await sessionManager.list().catch(() => []);
      const selection = knownSession
        ? { session: knownSession, candidates: [knownSession] }
        : resolveSessionByPrefix(metas, arg);
      if (!selection.session && selection.candidates.length > 1) {
        state.status = formatAmbiguousSessionNotice(arg, selection.candidates);
        render(state);
        return;
      }
      const target = selection.session;
      if (!target) {
        state.status = arg ? `No session found: ${arg}` : "No saved sessions.";
        render(state);
        return;
      }
      const restoredSession = await sessionManager.load(target.id).catch(() => undefined);
      if (!restoredSession) {
        state.status = `No session found: ${target.id}`;
        render(state);
        return;
      }
      const mode = restoredSession.permissionMode ?? state.permissionMode;
      permissionManager.setMode(mode);
      state.permissionMode = mode;
      activeLlm = restoreLlmConfig(activeLlm, restoredSession);
      if (restoredSession.thinkingMode) activeThinkingMode = restoredSession.thinkingMode;
      if (restoredSession.thinkingLevel) {
        state.thinkingLevel = activeLlm.thinkingLevel ?? state.thinkingLevel;
      }
      if (restoredSession.skillNames) activeSkillNames = [...restoredSession.skillNames];
      state.modelName = activeLlm.provider + "/" + activeLlm.model;
      const base = await buildTuiHistory(mode);
      const systemPrompt = typeof base[0]?.content === "string" ? base[0].content : "";
      const restoredState = restoreTuiSession(
        restoredSession,
        systemPrompt,
        (session, prompt) => sessionManager.restoreHistory(session, prompt),
      );
      state.history = restoredState.history;
      activeSessionId = restoredSession.id;
      sessionManager.setSessionId(restoredSession.id);
      runtimeContext.sessionId = restoredSession.id;
      state.todoItems = restoredState.todos;
      state.todoRevision = restoredState.todoRevision;
      state.showWelcome = false;
      state.tools = [];
      state.pendingUser = undefined;
      state.status = `Session resumed ${target.id.slice(0, 8)} (${restoredSession.messages.length} messages)`;
      render(state);
      return;
    }
    if (text === "/memory" || text.startsWith("/memory ")) {
      const arg = text.slice("/memory".length).trim();
      const records = await memoryStore.list({ includeForgotten: arg === "--all" }).catch(() => []);
      if (records.length === 0) {
        state.status = "🧠 No memories yet (they are extracted as the conversation grows)";
        render(state);
        return;
      }
      const lines = records
        .slice(-8)
        .map((record) => `${record.status === "forgotten" ? "−" : "+"} ${record.key}: ${compactText(record.content, 60)}`);
      state.memoryEvents = [
        ...(state.memoryEvents ?? []),
        { added: [], forgotten: [], at: Date.now(), previews: Object.fromEntries(records.slice(-8).map((r) => [r.key, r.content])) },
      ];
      // Show the listing via notice for full-width readability.
      state.notice = {
        title: `🧠 Memories (${records.length}${arg === "--all" ? ", including forgotten" : ""})`,
        text: lines.join("\n"),
      };
      render(state);
      return;
    }
    const todoCommand = parseTodoCommand(text);
    if (todoCommand) {
      if (todoCommand === "clear") {
        state.todoItems = undefined;
        state.todoRevision = nextTodoRevision();
      } else {
        state.todoViewMode = todoViewModeForCommand(todoCommand, state.todoViewMode ?? "expanded");
      }
      state.input = "";
      render(state);
      return;
    }
    const skillCommand = applySkillCommand(text, activeSkillNames);
    if (skillCommand) {
      activeSkillNames = skillCommand.activation.activeNames;
      state.status = skillCommand.activation.activeNames.length > 0
        ? `Skills: ${skillCommand.activation.activeNames.join(", ")}`
        : "Skills: (none)";
      state.pendingUser = undefined;
      render(state);
      return;
    }

    const planTurnOverride = await parsePlanTurnOverride(text, {
      cwd,
      dispatch: dispatchPlanAction,
      setInput: (value) => {
        state.input = value;
        cursorCol = 0;
        cursorRow = 0;
      },
      planCaptureRef,
      execCaptureRef,
      permissionManager,
    });
    if (planTurnOverride === null) {
      state.pendingUser = undefined;
      render(state);
      return;
    }

    state.input = "";
    cursorCol = 0;
    cursorRow = 0;
    state.pendingUser = planTurnOverride?.displayText ?? text;
    state.showWelcome = false;
    state.streamingText = "";
    state.busy = true;
    state.status = "Waiting for model…";
    const parsedThinking = parseThinkingIntensityPrompt(text);
    const turnLlm = parsedThinking.intensity
      ? buildIntenseLlm(activeLlm, parsedThinking.intensity)
      : activeLlm;
    if (parsedThinking.intensity) {
      activeLlm = turnLlm;
      state.thinkingLevel = turnLlm.thinkingLevel ?? (turnLlm.reasoning ? "medium" : "off");
    }
    const thinkingMode = planTurnOverride
      ? loadThinkingModeFromEnv()
      : parsedThinking.intensity
      ? "fixed"
      : parseThinkingCommandMode(text) ?? loadThinkingModeFromEnv();
    render(state);
    const permissionTurn = permissionManager.beginTurn(
      activeSessionId,
      (request) => {
        state.pendingPermissionRequestId = request.id;
        state.pendingPermissionSessionId = activeSessionId;
        state.status = `Waiting for permission: ${request.tool} (${request.risk}) [A allow / D deny / Enter deny / Esc cancel]`;
        render(state);
      },
      abortController.signal,
    );
    let turnSucceeded = false;
    let turnErrorMessage: string | undefined;
    try {
      await persistTurn([
        ...state.history,
        { role: "user", content: planTurnOverride?.prompt ?? text },
      ]);
      state.history = await runAgentTurn(state.history, planTurnOverride?.prompt ?? text, {
        llm: { ...turnLlm, sessionId: activeSessionId },
        tools,
        autoSubagent,
        preprocessors: vision ? [createVisionPreprocessor(vision)] : [],
        signal: abortController.signal,
        permissionTurn,
        autoValidate: isTuiFeatureEnabled(process.env.MINI_AGENT_AUTO_VALIDATE),
        validationWorkspace: cwd,
        autoCheckpoint: isTuiFeatureEnabled(process.env.MINI_AGENT_AUTO_CHECKPOINT),
        thinkingMode,
        runtimeRef: parentRuntime,
        runtimeContext,
        globalTokenBudget,
        skillNames: activeSkillNames,
        skillRegistry: defaultSkillRegistry,
        onEvent: (event) => {
          handleEvent(state, event);
          if (event.type === "thinking_policy") {
            activeLlm = withThinkingLevel(activeLlm, event.level);
          }
          render(state);
        },
      });
      turnSucceeded = true;
      state.pendingUser = undefined;
      render(state);
    } catch (error) {
      if (error instanceof MaxTurnsExceededError) {
        state.history = error.messages;
        state.pendingUser = undefined;
        state.busy = false;
        state.status = `Turn limit reached (${error.maxTurns}); this turn stopped`;
        render(state);
        return;
      }
      state.pendingUser = undefined;
      state.busy = false;
      turnErrorMessage = error instanceof Error ? error.message : String(error);
      state.status = `Error: ${turnErrorMessage}`;
      render(state);
    } finally {
      permissionTurn.close();
      if (planTurnOverride?.restoreMode !== undefined && permissionManager.getMode() !== planTurnOverride.restoreMode) {
        permissionManager.setMode(planTurnOverride.restoreMode);
        dispatchPlanAction({ type: "SET_PERMISSION_MODE", mode: planTurnOverride.restoreMode });
      }
      // Persist both completed and interrupted turns. The turn-start snapshot
      // guarantees the prompt survives a crash before the first model reply.
      await persistTurn(state.history);
      if (turnSucceeded) {
        // Extract memories — best-effort and never blocks the answer.
        if (isAutoMemoryEnabled()) {
          // Reuse the module-scope memoryStore (same records.json path).
          const extract = createAutoMemoryHook(activeLlm, memoryStore);
          void extract(state.history)
            .then(async (result) => {
              if (!result.ran) return;
              // Fetch previews for the updated keys so the card shows content.
              const previews: Record<string, string> = {};
              for (const key of [...result.added, ...result.forgotten]) {
                const record = (await memoryStore.list({ includeForgotten: true }))
                  .find((item) => item.key === key);
                if (record) previews[key] = record.content;
              }
              state.memoryEvents = [
                ...(state.memoryEvents ?? []),
                { added: result.added, forgotten: result.forgotten, at: Date.now(), previews },
              ];
              const changed = result.added.length + result.forgotten.length;
              state.status = changed > 0
                ? `🧠 Memories updated automatically (${changed})`
                : "🧠 Memory check complete (no updates)";
              render(state);
            })
            .catch(() => {});
        }
      }
      await finalizePlanCapture({
        cwd,
        planCaptureRef,
        history: state.history,
        succeeded: turnSucceeded,
        dispatch: dispatchPlanAction,
      });
      await finalizeExecCapture({
        cwd,
        execCaptureRef,
        history: state.history,
        succeeded: turnSucceeded,
        errorMessage: turnErrorMessage,
        dispatch: dispatchPlanAction,
      });
      render(state);
    }
  };

  process.stdin.on("data", (chunk: string) => {
    let inputChunk = chunk;
    for (const [sequence, direction] of [
      ["\u001b[1;2A", "increase"],
      ["\u001b[1;2B", "decrease"],
      ["\u001b.", "increase"],
      ["\u001b,", "decrease"],
    ] as const) {
      if (!inputChunk.includes(sequence)) continue;
      if (!state.busy) adjustThinkingLevel(direction);
      inputChunk = inputChunk.replaceAll(sequence, "");
    }
    if (inputChunk.includes("\u0012")) {
      if (!state.busy) adjustThinkingLevel("increase", true);
      inputChunk = inputChunk.replaceAll("\u0012", "");
    }
    if (inputChunk.includes("\u001b[Z")) {
      if (state.sessionPicker) {
        const selected = selectedSessionFromPicker(state.sessionPicker);
        if (selected) {
          state.input = `/resume ${selected.id}`;
          state.sessionPicker = undefined;
          state.status = "Ready";
        }
      } else {
        const current = PERMISSION_MODES.indexOf(state.permissionMode);
        const next = PERMISSION_MODES[(current + 1) % PERMISSION_MODES.length] ?? "plan";
        permissionManager.setMode(next);
        state.permissionMode = permissionManager.getMode();
        state.status = `Permission mode: ${next}`;
      }
      inputChunk = inputChunk.replaceAll("\u001b[Z", "");
      render(state);
    }
    if (state.sessionPicker) {
      for (const [sequence, delta] of [["\u001b[A", -1] as const, ["\u001b[B", 1] as const]) {
        if (!inputChunk.includes(sequence)) continue;
        state.sessionPicker = moveSessionPicker(state.sessionPicker, delta);
        inputChunk = inputChunk.replaceAll(sequence, "");
        render(state);
      }
    }
    // Strip recognized escape sequences BEFORE the per-char loop so they're not
    // emitted as individual printable characters.
    const ARROW_SEQUENCES = ["\u001b[1;2A", "\u001b[1;2B", "\u001b[A", "\u001b[B", "\u001b[D", "\u001b[C"] as const;
    for (const seq of ARROW_SEQUENCES) {
      if (inputChunk.includes(seq)) inputChunk = inputChunk.replaceAll(seq, "");
    }
    // Emit arrow keys as individual tokens after stripping sequences above,
    // so that the per-char loop below can handle them explicitly.
    for (const char of inputChunk) {
      if (char === "\u0003") return quit();
      if (char === "\u001b") {
        if (state.sessionPicker) {
          state.sessionPicker = undefined;
          state.input = "";
          state.status = "Ready";
          render(state);
        }
        continue;
      }
      // Arrow keys (sent as individual up/down/left/right chars when terminfo is active)
      if (char === "\u0001" || char === "\u0005" || char === "\u0002" || char === "\u0006") {
        if (!state.busy && state.pendingUser === undefined) {
          if (char === "\u0001") {
            // Ctrl+A — move to start of input
            cursorCol = 0; cursorRow = 0;
            render(state);
          } else if (char === "\u0005") {
            // Ctrl+E — move to end of input
            const lines = state.input.split("\n");
            cursorRow = lines.length - 1;
            cursorCol = lines[cursorRow].length;
            render(state);
          } else if (char === "\u0002") {
            // Ctrl+B — move left
            if (cursorCol > 0) { cursorCol--; } else if (cursorRow > 0) {
              cursorRow--;
              cursorCol = state.input.split("\n")[cursorRow].length;
            }
            render(state);
          } else if (char === "\u0006") {
            // Ctrl+F — move right
            const lines = state.input.split("\n");
            if (cursorCol < lines[cursorRow].length) { cursorCol++; }
            else if (cursorRow < lines.length - 1) {
              cursorRow++;
              cursorCol = 0;
            }
            render(state);
          }
        }
        continue;
      }
      if (char === "\r" || char === "\n") {
        if (state.sessionPicker) {
          const selected = selectedSessionFromPicker(state.sessionPicker);
          if (selected) {
            state.sessionPicker = undefined;
            state.input = "";
            void submit(`/resume ${selected.id}`, selected);
          }
          continue;
        }
        // If there's a pending permission, deny it
        if (state.pendingPermissionRequestId && state.pendingPermissionSessionId) {
          permissionManager.resolve(state.pendingPermissionSessionId, state.pendingPermissionRequestId, "deny");
        state.pendingPermissionRequestId = undefined;
        state.pendingPermissionSessionId = undefined;
          state.status = "Permission denied";
          render(state);
          return;
        }
        void submit(state.input);
        continue;
      }
      if (char === "\t") {
        if (state.sessionPicker) {
          const selected = selectedSessionFromPicker(state.sessionPicker);
          if (selected) {
            state.input = `/resume ${selected.id}`;
            state.sessionPicker = undefined;
            state.status = "Ready";
            render(state);
          }
        }
        continue;
      }
      if (char === "\u007f") {
        if (!state.busy && state.pendingUser === undefined && state.input.length > 0) {
          // Delete character before cursor (handles multi-line)
          const lines = state.input.split("\n");
          if (cursorCol > 0) {
            lines[cursorRow] = lines[cursorRow].slice(0, cursorCol - 1) + lines[cursorRow].slice(cursorCol);
            cursorCol--;
          } else if (cursorRow > 0) {
            const prevLine = lines[cursorRow - 1];
            lines[cursorRow - 1] = prevLine + lines[cursorRow];
            lines.splice(cursorRow, 1);
            cursorRow--;
            cursorCol = prevLine.length;
          }
          state.input = lines.join("\n");
          render(state);
        }
        continue;
      }
      if (char >= " " && char !== "\u007f") {
        if (state.sessionPicker) continue;
        // Handle permission resolution: 'a' = allow, 'd' = deny
        if (state.pendingPermissionRequestId && state.pendingPermissionSessionId) {
          const decision = char === "a" || char === "A" ? "allow" as const : char === "d" || char === "D" ? "deny" as const : null;
          if (decision) {
            permissionManager.resolve(state.pendingPermissionSessionId, state.pendingPermissionRequestId, decision);
            state.pendingPermissionRequestId = undefined;
            state.pendingPermissionSessionId = undefined;
            state.status = decision === "allow" ? "Permission granted" : "Permission denied";
            render(state);
            return;
          }
          render(state);
          return;
        }
        if (!state.busy && state.pendingUser === undefined) {
          const lines = state.input.split("\n");
          lines[cursorRow] = lines[cursorRow].slice(0, cursorCol) + char + lines[cursorRow].slice(cursorCol);
          cursorCol++;
          state.input = lines.join("\n");
          render(state);
        }
        continue;
      }
    }
  });

  render(state);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
