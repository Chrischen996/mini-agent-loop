import { restoreAgentHistory } from "../loop.ts";
import { contentAsString } from "../content.ts";
import { switchLlmModel, type LlmConfig } from "../llm/index.ts";
import { withThinkingLevel } from "../think-intensity.ts";
import { nextTodoRevision, type TodoItem } from "../todo.ts";
import type { AgentMessage } from "../types.ts";
import type { PersistedSession, PersistedSessionMeta } from "../session-store.ts";
import {
  findSessionByPrefix,
  formatSessionCandidates,
  resolveSessionByPrefix,
} from "../session-manager.ts";
export { findSessionByPrefix, formatSessionCandidates, resolveSessionByPrefix };

export type StartupSessionRequest = {
  sessionId?: string;
  resume: boolean;
  fork: boolean;
};

export type SessionPickerState = {
  command: "resume" | "sessions";
  sessions: PersistedSessionMeta[];
  selectedIndex: number;
  loading: boolean;
};

/** Keep the session picker contract identical across Ink and ANSI renderers. */
export const SESSION_PICKER_HINT = "Tab fill /resume  ·  Enter resume selected  ↑↓ navigate  Esc close";

export function createSessionPickerState(
  command: SessionPickerState["command"],
  sessions: PersistedSessionMeta[] = [],
  loading = true,
): SessionPickerState {
  return { command, sessions, selectedIndex: 0, loading };
}

export function moveSessionPicker(
  state: SessionPickerState,
  delta: number,
): SessionPickerState {
  if (state.sessions.length === 0) return state;
  const next = (state.selectedIndex + delta) % state.sessions.length;
  return {
    ...state,
    selectedIndex: next < 0 ? next + state.sessions.length : next,
  };
}

export function selectedSessionFromPicker(
  state: SessionPickerState,
): PersistedSessionMeta | undefined {
  return state.sessions[state.selectedIndex];
}

export function parseResumeCommand(value: string): { prefix: string } | undefined {
  // Keep the slash form compatible with the command palette, while accepting
  // the bare spelling users commonly type when they call it a command.
  const match = value.trim().match(/^\/?resume(?:\s+(.*))?$/i);
  return match ? { prefix: match[1]?.trim() ?? "" } : undefined;
}

/** Parse startup session flags shared by the ANSI, legacy, and Ink entrypoints. */
export function getStartupSessionRequest(
  argv: readonly string[] = process.argv.slice(2),
  env: { MINI_AGENT_SESSION_ID?: string } = process.env,
): StartupSessionRequest {
  let sessionId = env.MINI_AGENT_SESSION_ID?.trim() || undefined;
  let resume = Boolean(sessionId);
  let fork = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--continue") {
      resume = true;
      continue;
    }
    if (arg === "--fork-session") {
      fork = true;
      // Forking is defined as resuming the selected/latest transcript into a
      // new session, so the flag is meaningful even without --resume.
      resume = true;
      continue;
    }
    if (arg === "--resume") {
      resume = true;
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        sessionId = next.trim() || undefined;
        index += 1;
      }
      continue;
    }
    if (arg?.startsWith("--resume=")) {
      resume = true;
      sessionId = arg.slice("--resume=".length).trim() || undefined;
    }
  }
  return { sessionId, resume, fork };
}

/** A normal TUI launch starts a new session; restore only when explicitly requested. */
export function getExplicitStartupSessionId(
  env: { MINI_AGENT_SESSION_ID?: string } = process.env,
): string | undefined {
  return getStartupSessionRequest([], env).sessionId;
}

/** Restore persisted model settings while tolerating removed models/credentials. */
export function restoreLlmConfig(
  current: LlmConfig,
  session: Pick<PersistedSession, "modelId" | "thinkingLevel">,
): LlmConfig {
  let next = current;
  if (session.modelId && session.modelId !== next.model) {
    try {
      next = switchLlmModel(next, session.modelId);
    } catch {
      // A session can outlive a catalog entry or its credentials.
    }
  }
  if (session.thinkingLevel) next = withThinkingLevel(next, session.thinkingLevel);
  return next;
}

/** Convert the richer TUI Todo state to the persisted wire format. */
export function toPersistedTodos(
  items: readonly TodoItem[] | undefined,
): PersistedSession["todos"] {
  if (!items) return undefined;
  return items.map((item) => ({
    id: item.id,
    content: item.content,
    activeForm: item.activeForm,
    // The wire format predates TUI-only failed/skipped states.
    status: item.status === "completed"
      ? "completed" as const
      : item.status === "in_progress"
        ? "in_progress" as const
        : "pending" as const,
  }));
}

/** Rehydrate persisted Todo items with the fields required by the TUI. */
export function fromPersistedTodos(
  items: PersistedSession["todos"],
): TodoItem[] | undefined {
  if (!items) return undefined;
  return items.map((item) => ({
    id: item.id,
    content: item.content,
    activeForm: item.activeForm ?? item.content,
    status: item.status,
    source: "model" as const,
  }));
}

export type SessionHistoryRestorer = (
  session: PersistedSession,
  systemPrompt: string,
) => AgentMessage[];

/** Shared TUI copy for an ambiguous `/resume` or startup prefix. */
export function formatAmbiguousSessionNotice(
  prefix: string,
  candidates: readonly PersistedSessionMeta[],
): string {
  return `Prefix ${prefix || "(latest)"} matches multiple sessions. Use a longer prefix or the full ID:\n${formatSessionCandidates(candidates)}`;
}

export type ResumeMessageCandidate = {
  role: "user" | "assistant";
  text: string;
  /** Number of non-system transcript messages retained at this point. */
  boundary: number;
  /** Original message id, when persisted. */
  id?: string;
};

/**
 * Build the user-visible rewind points for a resumed transcript. Tool results
 * are not separate choices; an assistant tool-call choice includes its whole
 * contiguous tool-result block so the restored history remains provider-safe.
 */
export function getResumeMessageCandidates(
  messages: readonly AgentMessage[],
): ResumeMessageCandidate[] {
  const visible = messages.filter((message) => message.role !== "system");
  const candidates: ResumeMessageCandidate[] = [];
  for (let index = 0; index < visible.length; index += 1) {
    const message = visible[index]!;
    if (message.role !== "user" && message.role !== "assistant") continue;
    let end = index + 1;
    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
      while (end < visible.length && visible[end]?.role === "tool") end += 1;
    }
    candidates.push({
      role: message.role,
      text: contentAsString(message.content),
      boundary: end,
      ...(message.id ? { id: message.id } : {}),
    });
    index = end - 1;
  }
  return candidates;
}

export function messageBoundaryForSelection(
  candidates: readonly ResumeMessageCandidate[],
  index: number,
): number | undefined {
  return candidates[index]?.boundary;
}

export type RestoredTuiSession = {
  history: AgentMessage[];
  todos?: TodoItem[];
  todoRevision: number;
};

/** Rebuild the transcript and presentation state shared by all TUI entrypoints. */
export function restoreTuiSession(
  session: PersistedSession,
  systemPrompt: string,
  restoreHistory: SessionHistoryRestorer = (value, prompt) => restoreAgentHistory(value.messages, prompt),
): RestoredTuiSession {
  const todos = fromPersistedTodos(session.todos);
  return {
    history: restoreHistory(session, systemPrompt),
    todos,
    todoRevision: session.todoVersion ?? (todos ? nextTodoRevision() : 0),
  };
}
