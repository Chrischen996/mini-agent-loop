// Session restore: resume, fork, and foreign-session import for the TUI.
//
// All three paths end in the same place — a restored transcript plus the model,
// permission, thinking, skill and provenance state that belongs to it — so they
// live together instead of inside the component. The component supplies live
// refs; these helpers never read React state directly.

import { realpath } from "node:fs/promises";
import path from "node:path";
import type { Dispatch, MutableRefObject } from "react";
import { resolveSessionByPrefix, type SessionManager } from "../../session-manager.ts";
import {
  ForeignSessionError,
  formatForeignSessionList,
  importForeignSession,
  listForeignSessions,
} from "../../foreign-session.ts";
import type { PersistedSession } from "../../session-store.ts";
import type { LlmConfig } from "../../llm/index.ts";
import type { PermissionManager } from "../../permissions.ts";
import type { AgentMessage } from "../../types.ts";
import type { TuiAction, TuiState } from "../state.ts";
import { formatAmbiguousSessionNotice, restoreTuiSession } from "../session-serialization.ts";
import { restoreTuiLlmConfig, restoreTuiModelConfig } from "../model-isolation.ts";
import { buildTuiSystemPrompt, type TuiSystemPromptContext } from "../system-prompt.ts";
import { loadSkillNamesFromEnv } from "../../skills/index.ts";
import { loadThinkingModeFromEnv } from "../../thinking-policy.ts";
import { GitWorkflow } from "../../git/workflow.ts";
import { resolveSessionWorkspaceCwd } from "../session-workspace.ts";

/** Cap persisted message count to keep session files bounded on very long sessions. */
export const MAX_PERSISTED_MESSAGES = 2_000;
/** In-memory history cap: keep the conversation productive without letting the
 *  raw AgentMessage array grow past what two context windows would hold. */
export const MAX_IN_MEMORY_MESSAGES = 2_500;

export type SessionRestoreDeps = {
  cwd: string;
  projectCwd: string;
  agentId: string;
  dispatch: Dispatch<TuiAction>;
  systemPromptContext: TuiSystemPromptContext;
  stateRef: MutableRefObject<TuiState>;
  llmRef: MutableRefObject<LlmConfig>;
  historyRef: MutableRefObject<AgentMessage[]>;
  activeTodosRef: MutableRefObject<TuiState["todoItems"]>;
  localRoleLlmConfigsRef: MutableRefObject<Record<string, LlmConfig>>;
  skillNamesRef: MutableRefObject<string[]>;
  thinkingPolicyModeRef: MutableRefObject<ReturnType<typeof loadThinkingModeFromEnv>>;
  sessionProvenanceRef: MutableRefObject<
    Pick<PersistedSession, "parentSessionId" | "forkedFromMessage" | "forkedFromMessageId" | "origin">
  >;
  getSessionManager: () => SessionManager;
  getPermissionManager: () => PermissionManager;
  setConversationId: (id: string) => void;
  setLlm: (config: LlmConfig) => void;
  setSkillNames: (names: string[]) => void;
  onWorkspaceChange: (agentId: string, cwd: string, branch?: string) => void;
};

/**
 * Resume (or fork) a saved session by id or unique prefix.
 *
 * Returns false when nothing matched or the load failed; the failure is also
 * surfaced as a notice so the prompt does not look like it silently ignored the
 * command.
 */
export async function resumeSessionInTui(
  deps: SessionRestoreDeps,
  prefix: string,
  fork = false,
): Promise<boolean> {
  const {
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
  } = deps;

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

    // A session may have run in an isolated worktree; move the mounted session
    // there so tools and Git commands see the same tree the history came from.
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
    const restoredModel = restoreTuiLlmConfig(llmRef.current, session);
    const restoredLlm = restoredModel.config;
    const restoredSkillNames = session.skillNames ? [...session.skillNames] : loadSkillNamesFromEnv();
    localRoleLlmConfigsRef.current = Object.fromEntries(
      Object.entries(session.subagentModelConfigs ?? {}).flatMap(([role, snapshot]) => {
        const config = restoreTuiModelConfig(restoredLlm, snapshot);
        return config ? [[role, config]] : [];
      }),
    );
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
    if (restoredModel.warning) {
      dispatch({ type: "ADD_NOTICE", title: "Model unavailable", text: `Could not restore ${restoredModel.warning}; keeping the current model.` });
    }
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
}

/** List (no reference) or import (reference) a Claude Code / Codex session. */
export async function importForeignSessionInTui(
  deps: SessionRestoreDeps,
  source: "claude" | "codex",
  reference: string,
): Promise<void> {
  const {
    cwd,
    dispatch,
    systemPromptContext,
    stateRef,
    llmRef,
    historyRef,
    activeTodosRef,
    localRoleLlmConfigsRef,
    sessionProvenanceRef,
    getSessionManager,
    getPermissionManager,
    setConversationId,
  } = deps;

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
    localRoleLlmConfigsRef.current = {};
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
}
