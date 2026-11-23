// Slash-command dispatch for the Ink session view.
//
// `handleSubmit` used to inline this cascade. It now lives here so the command
// ordering is readable (and testable) without the surrounding React component.
//
// Contract: return `HANDLED` when the input was fully consumed by a local
// command. Returning `undefined` means "not a command" — the caller continues
// with a normal agent turn.

import { randomUUID } from "node:crypto";
import { findExactModelReferenceMatch, getAllModels } from "../../models.ts";
import { switchLlmModel, type LlmConfig, type ModelSwitchOverrides } from "../../llm/index.ts";
import { getThinkingLevelChoices } from "../../think-intensity.ts";
import type { ModelThinkingLevel } from "../../pi-ai/types.ts";
import { loadProfileStore, removeProfile } from "../../profile-store.ts";
import { resolveToolProvider, type Tool, type ToolProvider } from "../../tools/types.ts";
import type { AgentMessage } from "../../types.ts";
import { initAgentMd } from "../../init-agent-md.ts";
import { applySkillCommand } from "../../skills/index.ts";
import { GitWorkflow } from "../../git/workflow.ts";
import type { McpServerStatus } from "../../mcp/types.ts";
import { formatMcpStatusDetails } from "../../mcp/status.ts";
import type { BgTaskManager } from "../../bg-tasks/manager.js";
import type { PermissionManager } from "../../permissions.ts";
import type { SessionManager } from "../../session-manager.ts";
import type { Dispatch, MutableRefObject } from "react";
import type { ImageAttachment, TuiAction, TuiState } from "../state.ts";
import type { AcMode } from "../input-utils.ts";
import type { ModelPickerSection } from "../model-picker.ts";
import type { SlashCommand } from "../slash-commands.ts";
import type { CopyTarget } from "../copy-text.ts";
import type { ModelSelectOptions } from "../model-switcher.ts";
import type { PlanOverrideResult } from "../plan-commands.ts";
import type { TuiSystemPromptContext } from "../system-prompt.ts";
import type { ThinkingMode } from "../../thinking-policy.ts";
import { parseModelCommand, modelSubmitNeedsSetup } from "../model-command.ts";
import { parsePlanTurnOverride } from "../plan-commands.ts";
import { applyTheme, persistThemeName, formatThemeListText, activeThemeName } from "../theme.ts";
import { serializeTuiModelConfig } from "../model-isolation.ts";
import { bgTaskStatusGlyph } from "../bg-task-status-color.ts";
import { parseBackgroundTaskCommand, parseSlashCommand, parseUnknownSlashCommand } from "../slash-commands.ts";
import { parseInitCommand } from "../init-command.ts";
import { parseTodoCommand, todoViewModeForCommand } from "../todo-commands.ts";
import { parseCopyCommand } from "../copy-text.ts";
import { loadImageAttachment } from "../image-attachments.ts";
import { parseForeignResumeCommand, parseResumeCommand } from "../session-serialization.ts";
import { createTuiAgentHistory } from "../system-prompt.ts";
import { SLASH_COMMANDS } from "../components/FileAutocomplete.tsx";

/** The input was consumed locally; no agent turn should run. */
export type CascadeResult =
  | { handled: true }
  | { handled: false; planTurnOverride: PlanOverrideResult | null | undefined };

/** Sentinel returned when a local command consumed the input. */
export const HANDLED: CascadeResult = { handled: true };

export type CommandCascadeContext = {
  cwd: string;
  state: TuiState;
  dispatch: Dispatch<TuiAction>;
  setInput: (value: string) => void;
  llm: LlmConfig;
  llmRef: MutableRefObject<LlmConfig>;
  historyRef: MutableRefObject<AgentMessage[]>;
  activeTodosRef: MutableRefObject<TuiState["todoItems"]>;
  localRoleLlmConfigsRef: MutableRefObject<Record<string, LlmConfig>>;
  pendingImagesRef: MutableRefObject<ImageAttachment[]>;
  skillNamesRef: MutableRefObject<string[]>;
  thinkingPolicyModeRef: MutableRefObject<ThinkingMode>;
  sessionProvenanceRef: MutableRefObject<Record<string, unknown>>;
  planCaptureRef: MutableRefObject<{ prompt: string } | null>;
  execCaptureRef: MutableRefObject<{ mode: "run" | "retry" } | null>;
  diffFilesRef: MutableRefObject<string[]>;
  resizeRefreshRef: MutableRefObject<number>;
  sessionManagerRef: MutableRefObject<SessionManager | null>;
  acModeRef: MutableRefObject<AcMode>;
  modelPickerSectionRef: MutableRefObject<ModelPickerSection>;
  allToolsRef: MutableRefObject<ToolProvider>;
  mcpStatuses?: () => readonly McpServerStatus[];
  mcpTools?: () => readonly Tool[];
  modelContextWindows: Record<string, number>;
  systemPromptContext: TuiSystemPromptContext;
  getBgManager: () => BgTaskManager | null;
  getPermissionManager: () => PermissionManager;
  getSessionManager: () => SessionManager;
  refreshBgTaskCount: () => Promise<void>;
  persistSessionSnapshot: (messages: AgentMessage[], modelConfig?: LlmConfig) => Promise<void>;
  resumeSession: (prefix: string) => Promise<boolean>;
  importForeign: (source: "claude" | "codex", reference: string) => Promise<void>;
  copyResolvedText: (target?: CopyTarget) => Promise<void>;
  addPendingImageRef: (image: ImageAttachment) => boolean;
  handlePasteImageRef: () => Promise<boolean>;
  runDirectToolRef: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  runTodosCommand: (input: string, parsed: SlashCommand, confirmed?: boolean) => Promise<void>;
  selectModelRef: (reference: string, overrides?: ModelSwitchOverrides, options?: ModelSelectOptions) => void;
  openProfileListRef: (profileNames?: string[]) => Promise<unknown>;
  openModelPicker: (query?: string) => void;
  openEffortPicker: () => void;
  handleEffortConfirm: (level: ModelThinkingLevel) => void;
  setSkillNames: (names: string[]) => void;
  setConversationId: (id: string) => void;
  setAcMode: (mode: AcMode) => void;
  setAcIndex: (index: number) => void;
  setBgPanelOpen: (open: boolean) => void;
  setTasksPaneOpen: (open: boolean) => void;
  setThemeDialogOpen: (open: boolean) => void;
  setDiffFileCandidates: (files: string[]) => void;
  exit: () => void;
};

/**
 * Run the local slash-command cascade for `trimmed`.
 *
 * Returns `HANDLED` when a command consumed the input. Returns a plan-turn
 * override when the input must run as an agent turn (see `parsePlanTurnOverride`),
 * and `undefined` when the input is an ordinary prompt.
 */
export async function runCommandCascade(
  ctx: CommandCascadeContext,
  trimmed: string,
): Promise<CascadeResult> {
  const {
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
    mcpStatuses,
    mcpTools,
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
  } = ctx;

  // The body below is the historical `handleSubmit` cascade verbatim; the only
  // change is that a bare `return;` became `return HANDLED;`.

  const foreignResume = parseForeignResumeCommand(trimmed);
  if (foreignResume) {
    setInput("");
    await importForeign(foreignResume.source, foreignResume.reference);
    return HANDLED;
  }
  const resumeCommand = parseResumeCommand(trimmed);
  if (resumeCommand) {
    setInput("");
    if (resumeCommand.prefix) {
      await resumeSession(resumeCommand.prefix);
    } else {
      setInput("/resume");
    }
    return HANDLED;
  }
  if (trimmed === "/sessions") {
    setInput("/sessions");
    return HANDLED;
  }

  const backgroundTaskCommand = parseBackgroundTaskCommand(trimmed);
  if (backgroundTaskCommand) {
    setInput("");
    const manager = getBgManager();
    if (!manager) {
      dispatch({ type: "ADD_NOTICE", title: "Background tasks", text: "Background tasks are unavailable in this session." });
      return HANDLED;
    }
    try {
      await manager.initialize();
      const matches = (await manager.list()).filter((task) => task.taskId.startsWith(backgroundTaskCommand.reference));
      if (matches.length !== 1) {
        dispatch({
          type: "ADD_NOTICE",
          title: "Background tasks",
          text: matches.length === 0
            ? `No task matches ${backgroundTaskCommand.reference}.`
            : `Task reference ${backgroundTaskCommand.reference} is ambiguous: ${matches.map((task) => task.taskId).join(", ")}`,
        });
        return HANDLED;
      }
      await manager.send(matches[0]!.taskId, { text: backgroundTaskCommand.text, enter: true });
      dispatch({ type: "ADD_NOTICE", title: "Background task", text: `Input sent to ${matches[0]!.taskId}.` });
    } catch (error) {
      dispatch({
        type: "ADD_NOTICE",
        title: "Background task input failed",
        text: error instanceof Error ? error.message : String(error),
      });
    }
    return HANDLED;
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
      return HANDLED;
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
          return `${bgTaskStatusGlyph(task.status)} ${task.status.padEnd(10)} ${task.taskId.slice(0, 8)}  ${task.name}${duration}${exit}`;
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
    return HANDLED;
  }
  // /tasks-pane opens the per-session tasks pane. /tasks remains the todo
  // runner (/tasks run --parallel), so the pane command is separate.
  if (trimmed === "/tasks-pane") {
    setTasksPaneOpen(true);
    setAcMode(null);
    setInput("");
    return HANDLED;
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
    return HANDLED;
  }
  if (trimmed === "/exit" || trimmed === "/quit") { exit(); return HANDLED; }
  if (trimmed === "/clear") {
    historyRef.current = createTuiAgentHistory(getPermissionManager().getMode(), systemPromptContext);
    pendingImagesRef.current = [];
    dispatch({ type: "RESET" });
    setInput("");
    // Generate new conversation ID for fresh session
    const nextSessionId = randomUUID();
    sessionManagerRef.current?.newSession(nextSessionId);
    localRoleLlmConfigsRef.current = {};
    const nextLlm = llmRef.current;
    void getSessionManager().save({
      id: nextSessionId,
      modelId: `${nextLlm.provider}/${nextLlm.model}`,
      modelConfig: serializeTuiModelConfig(nextLlm),
      thinkingLevel: nextLlm.thinkingLevel,
      thinkingMode: thinkingPolicyModeRef.current,
      permissionMode: getPermissionManager().getMode(),
      cwd,
      messages: historyRef.current,
    }).catch((error) => dispatch({
      type: "ADD_NOTICE",
      title: "Session save failed",
      text: error instanceof Error ? error.message : String(error),
    }));
    sessionProvenanceRef.current = {};
    activeTodosRef.current = undefined;
    setConversationId(nextSessionId);
    return HANDLED;
  }
  if (trimmed === "/context") {
    const compactions = state.contextCompactions;
    const tokenEst = state.contextTokens;
    const ctxWindow = modelContextWindows[state.modelName] ?? llm.contextWindow ?? 128000;
    const pct = ctxWindow > 0 ? Math.round(tokenEst / ctxWindow * 100) : 0;
    const lines = [
      `Context usage: ${tokenEst} / ${ctxWindow} tokens (${pct}%)`,
      '',
    ];
    if (compactions.length === 0) {
      lines.push('No compaction history (context is below the threshold)');
    } else {
      lines.push(`Compacted ${compactions.length} times:`);
      for (const c of compactions.slice(-5)) {
        lines.push(`  turn${c.turn}: ${c.before} → ${c.after} (${c.reason})`);
      }
    }
    dispatch({ type: "ADD_NOTICE", title: "Context usage", text: lines.join("\n") });
    setInput("");
    return HANDLED;
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
    return HANDLED;
  }

  if (/^\/paste-image$/i.test(trimmed)) {
    setInput("");
    await handlePasteImageRef();
    return HANDLED;
  }

  // /image <path> - add pending image
  const imageMatch = trimmed.match(/^\/image\s+(.+)$/i);
  if (imageMatch) {
    const imagePath = imageMatch[1]!.trim();
    if (imagePath.toLowerCase() === "clear") {
      pendingImagesRef.current = [];
      dispatch({ type: "CLEAR_PENDING_IMAGES" });
      setInput("");
      return HANDLED;
    }
    try {
      addPendingImageRef(await loadImageAttachment(imagePath, cwd));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      dispatch({ type: "ATTACHMENT_ERROR", message: `Unable to attach image: ${detail}` });
    }
    setInput("");
    return HANDLED;
  }
  const copyTarget = parseCopyCommand(trimmed);
  if (copyTarget) {
    setInput("");
    await copyResolvedText(copyTarget);
    return HANDLED;
  }

  if (trimmed === "/help" || trimmed === "/?") {
    dispatch({
      type: "ADD_NOTICE",
      title: "Available commands",
      text: SLASH_COMMANDS.map((command) => `${command.usage.padEnd(28)} ${command.description}`).join("\n"),
    });
    setInput("");
    return HANDLED;
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
    return HANDLED;
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
    return HANDLED;
  }

  // /profiles: show profile list
  if (/^\/profiles?$/i.test(trimmed)) {
    await openProfileListRef();
    return HANDLED;
  }

  // /profiles delete <name>
  const modelRoleMatch = trimmed.match(/^\/model-role\s+([\w-]+)\s+(.+)$/i);
  if (modelRoleMatch) {
    const role = modelRoleMatch[1]!.toLowerCase();
    const profileName = modelRoleMatch[2]!.trim();
    try {
      if (profileName.toLowerCase() === "clear") {
        delete localRoleLlmConfigsRef.current[role];
      } else {
        const store = await loadProfileStore();
        const profile = store.profiles[profileName];
        if (!profile) throw new Error(`Profile not found: ${profileName}`);
        const roleLlm = switchLlmModel(llmRef.current, profile.model, {
          baseUrl: profile.baseUrl,
          apiKey: profile.apiKey,
        });
        localRoleLlmConfigsRef.current = { ...localRoleLlmConfigsRef.current, [role]: roleLlm };
      }
      await persistSessionSnapshot(historyRef.current);
      dispatch({
        type: "ADD_NOTICE",
        title: "Subagent model",
        text: profileName.toLowerCase() === "clear"
          ? `Cleared the ${role} model override for this conversation.`
          : `Set the ${role} model override for this conversation.`,
      });
    } catch (error) {
      dispatch({ type: "ADD_NOTICE", title: "Subagent model", text: error instanceof Error ? error.message : String(error) });
    }
    setInput("");
    return HANDLED;
  }

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
    return HANDLED;
  }

  // /theme [name]: list or switch terminal color themes (gemini-cli style).
  const themeCommandMatch = trimmed.match(/^\/theme(?:\s+(\S+))?$/i);
  if (themeCommandMatch) {
    const themeArg = themeCommandMatch[1]?.toLowerCase();
    if (!themeArg) {
      setThemeDialogOpen(true);
    } else if (applyTheme(themeArg)) {
      persistThemeName(themeArg);
      // Re-print the recent stream window so visible history picks up the
      // new palette; older frozen lines keep their old colors. NaN defeats
      // the width-equality guard in the resize-refresh effect exactly once.
      resizeRefreshRef.current = Number.NaN;
      dispatch({ type: "ADD_NOTICE", title: "Theme", text: `Theme set to "${activeThemeName()}". Selection saved for next start.` });
    } else {
      dispatch({ type: "ADD_NOTICE", title: "Theme", text: `Unknown theme "${themeArg}".\n\n${formatThemeListText()}` });
    }
    setInput("");
    return HANDLED;
  }

  if (/^\/model(?:\s+.*)?$/i.test(trimmed)) {
    const parsed = parseModelCommand(trimmed.replace(/^\/model\s*/i, ""));
    if (!parsed.reference) {
      setInput("");
      openModelPicker();
    } else {
      const match = findExactModelReferenceMatch(parsed.reference, getAllModels());
      if (match?.ambiguous) openModelPicker(parsed.reference);
      else {
        // Any `/model ref` reaching the submit handler is a catalog-side
        // selection and forces the credential form. The "Configured models"
        // side never gets here: its Enter path short-circuits earlier in
        // onSubmit via activateConfiguredProfileRef, and Tab completion is
        // blocked there (resolveAutocompleteNav returns "ignore"). Tab
        // completion on the catalog side clears acMode BEFORE the user hits
        // Enter, so acMode alone can't distinguish "Tab-completed from the
        // catalog" from "typed at the idle prompt" - both must re-enter the
        // API key. Only an explicit configured-section picker submission
        // (live model-picker on the configured side) keeps saved-profile
        // reuse. acMode/section are not in this callback's dependency
        // array, so read the live values from refs.
        const liveAcMode = acModeRef.current;
        const livePickerSection = modelPickerSectionRef.current;
        selectModelRef(
          parsed.reference,
          parsed.overrides,
          modelSubmitNeedsSetup(liveAcMode, livePickerSection) ? { forceSetup: true } : undefined,
        );
      }
    }
    return HANDLED;
  }

  // /effort: Antigravity-style Effort slider over the levels the active
  // model actually supports; an explicit level argument applies directly.
  if (/^\/effort(?:\s+(?:off|minimal|low|med|medium|high|xhigh|max|ultra))?$/i.test(trimmed)) {
    setInput("");
    const arg = trimmed.replace(/^\/effort\s*/i, "").trim().toLowerCase();
    if (arg) {
      const normalized = arg === "med" ? "medium" : arg;
      const levels = getThinkingLevelChoices(llmRef.current);
      const requested = (levels as string[]).includes(normalized) ? normalized as ModelThinkingLevel : undefined;
      if (requested) {
        handleEffortConfirm(requested);
      } else {
        dispatch({
          type: "ADD_NOTICE",
          title: "Effort",
          text: `Level "${arg}" is not supported by ${llm.provider}/${llm.model}. Supported: ${levels.join(", ")}`,
        });
      }
      return HANDLED;
    }
    openEffortPicker();
    return HANDLED;
  }

  // /diff opens a picker over the workspace's changed files; Enter shows
  // the selected file's Git diff as a local notice (no model turn).
  if (/^\/diff$/i.test(trimmed)) {
    setInput("");
    try {
      const files = await new GitWorkflow(cwd).changedFiles();
      if (files.length === 0) {
        dispatch({ type: "ADD_NOTICE", title: "Git diff", text: "No changed files in this workspace." });
        return HANDLED;
      }
      diffFilesRef.current = files.map((file) => file.path);
      setDiffFileCandidates(diffFilesRef.current);
      setAcIndex(0);
      setAcMode("workspace-diff-files");
    } catch (error) {
      dispatch({ type: "ADD_NOTICE", title: "Git diff", text: error instanceof Error ? error.message : String(error) });
    }
    return HANDLED;
  }

  // /init uses the bounded LLM project snapshot from initAgentMd. --print
  // previews the deterministic template without calling the model or writing.
  const initCommand = parseInitCommand(trimmed);
  if (initCommand) {
    setInput("");
    if (initCommand.kind === "error") {
      dispatch({ type: "ADD_NOTICE", title: "Init", text: initCommand.message });
      return HANDLED;
    }
    try {
      const result = await initAgentMd({
        cwd,
        force: initCommand.force,
        print: initCommand.print,
        llm: !initCommand.print,
        llmConfig: llm,
      });
      if (initCommand.print) {
        dispatch({ type: "ADD_NOTICE", title: "AGENT.MD Template Preview", text: result.content });
        return HANDLED;
      }
      dispatch({
        type: "ADD_NOTICE",
        title: "AGENT.MD",
        text: `${result.overwritten ? "Overwrote" : "Created"} AGENT.MD. Instructions are now active for subsequent turns.${result.llmFallback ? " Model generation failed; used the template instead." : ""}`,
      });
    } catch (error) {
      dispatch({
        type: "ADD_NOTICE",
        title: "Init Failed",
        text: error instanceof Error ? error.message : String(error),
      });
    }
    return HANDLED;
  }

  // Slash commands → direct tool
  const slashCmd = parseSlashCommand(trimmed);
  if (slashCmd) {
    if (slashCmd.cmd === "todos-run") {
      void runTodosCommand(trimmed, slashCmd);
      return HANDLED;
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
    return HANDLED;
  }

  // A leading "/" that is not a known command is a typo, not a prompt.
  // Sending it to the model wasted a turn and produced a confusing answer.
  const unknownCommand = parseUnknownSlashCommand(trimmed);
  if (unknownCommand && !planTurnOverride) {
    setInput("");
    dispatch({
      type: "ADD_NOTICE",
      title: "Unknown command",
      text: `${unknownCommand} is not a command. Use /help to list the available commands.`,
    });
    return HANDLED;
  }

  return { handled: false, planTurnOverride };
}
