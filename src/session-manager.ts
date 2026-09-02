import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  getDataRoot,
  SessionStore,
  type PersistedSession,
  type PersistedSessionMeta,
  type SessionStoreOptions,
} from "./session-store.ts";
import { restoreAgentHistory } from "./loop.ts";
import { sanitizeResumableMessages } from "./session-history.ts";
import type { AgentMessage, MessageContent } from "./types.ts";

export { sanitizeResumableMessages } from "./session-history.ts";

export type SessionSelection = {
  session?: PersistedSessionMeta;
  candidates: PersistedSessionMeta[];
};

/** Fields supplied by an entry point when writing a session snapshot. */
export type SessionSnapshotInput = Omit<PersistedSession, "id" | "createdAt"> & {
  id?: string;
  createdAt?: number;
};

export type SessionManagerOptions = Omit<SessionStoreOptions, "workspaceId"> & {
  dataDir?: string;
  workspaceId?: string;
  sessionId?: string;
};

/**
 * Resolve a session reference without silently choosing between collisions.
 * Exact IDs win over prefix matches; an empty reference means most recent.
 */
export function resolveSessionByPrefix(
  sessions: readonly PersistedSessionMeta[],
  prefix = "",
): SessionSelection {
  const normalized = prefix.trim();
  if (!normalized) {
    return sessions[0]
      ? { session: sessions[0], candidates: [sessions[0]] }
      : { candidates: [] };
  }

  const exact = sessions.find((session) => session.id === normalized);
  if (exact) return { session: exact, candidates: [exact] };

  const candidates = sessions.filter((session) => session.id.startsWith(normalized));
  return candidates.length === 1
    ? { session: candidates[0], candidates }
    : { candidates };
}

/** Compatibility helper for callers that only need an unambiguous match. */
export function findSessionByPrefix(
  sessions: readonly PersistedSessionMeta[],
  prefix = "",
): PersistedSessionMeta | undefined {
  return resolveSessionByPrefix(sessions, prefix).session;
}

/** Shared candidate format for CLI and all TUI resume notices. */
export function formatSessionCandidates(
  candidates: readonly PersistedSessionMeta[],
): string {
  return candidates
    .map((session) => {
      const when = new Date(session.lastActiveAt).toISOString();
      const preview = session.preview || "(no prompt preview)";
      return `  ${session.id}  ${when}  msgs=${session.messageCount}  ${preview}`;
    })
    .join("\n");
}

/**
 * Shared session lifecycle used by CLI, server, and terminal clients.
 *
 * SessionStore owns the durable format and locking. This class owns the
 * repeated entry-point policy: workspace scoping, active-session selection,
 * atomic upsert, turn-start checkpoints, and prompt-safe history restoration.
 */
export class SessionManager {
  readonly store: SessionStore;
  private activeSessionId: string;
  private readonly workspaceId: string | undefined;

  constructor(options: SessionManagerOptions = {}) {
    const { dataDir, workspaceId, sessionId, ...storeOptions } = options;
    this.workspaceId = workspaceId;
    this.store = new SessionStore(
      dataDir ?? path.join(getDataRoot(), "sessions"),
      { ...storeOptions, workspaceId },
    );
    this.activeSessionId = sessionId ?? randomUUID();
  }

  get sessionId(): string {
    return this.activeSessionId;
  }

  setSessionId(sessionId: string): void {
    this.activeSessionId = sessionId;
  }

  newSession(sessionId = randomUUID()): string {
    this.activeSessionId = sessionId;
    return sessionId;
  }

  async list(): Promise<PersistedSessionMeta[]> {
    return this.store.listSessions();
  }

  async loadAll(): Promise<Map<string, PersistedSession>> {
    const sessions = await this.store.loadAll();
    for (const session of sessions.values()) {
      session.messages = sanitizeResumableMessages(session.messages);
    }
    return sessions;
  }

  async load(sessionId = this.activeSessionId): Promise<PersistedSession | undefined> {
    const session = await this.store.load(sessionId);
    if (session) session.messages = sanitizeResumableMessages(session.messages);
    return session;
  }

  async loadMostRecent(): Promise<PersistedSession | undefined> {
    const [meta] = await this.list();
    return meta ? this.load(meta.id) : undefined;
  }

  async activate(sessionId: string): Promise<PersistedSession | undefined> {
    const session = await this.load(sessionId);
    if (session) this.activeSessionId = session.id;
    return session;
  }

  /**
   * Copy a persisted conversation into a new session, preserving its
   * transcript and session-scoped state without changing the parent record.
   */
  async fork(
    sessionId = this.activeSessionId,
    newSessionId: string = randomUUID(),
  ): Promise<PersistedSession | undefined> {
    const parent = await this.load(sessionId);
    if (!parent) return undefined;

    const visibleMessages = parent.messages.filter((message) => message.role !== "system");
    const child: PersistedSession = {
      ...parent,
      id: newSessionId,
      createdAt: Date.now(),
      lastActiveAt: undefined,
      // Forked records must not share mutable transcript/state objects with
      // the parent; later turns can append tool results or update the plan.
      messages: structuredClone(parent.messages),
      todos: parent.todos ? structuredClone(parent.todos) : parent.todos,
      skillNames: parent.skillNames ? [...parent.skillNames] : parent.skillNames,
      currentPlan: parent.currentPlan
        ? { ...structuredClone(parent.currentPlan), sessionId: newSessionId }
        : undefined,
      parentSessionId: parent.id,
      forkedFromMessage: visibleMessages.length,
      forkedFromMessageId: visibleMessages.at(-1)?.id,
    };
    const persisted = await this.save(child);
    this.activeSessionId = persisted.id;
    return persisted;
  }

  async remove(sessionId: string): Promise<void> {
    await this.store.remove(sessionId);
    if (this.activeSessionId === sessionId) this.newSession();
  }

  /** Save a complete snapshot while preserving creation time and workspace. */
  async save(input: SessionSnapshotInput): Promise<PersistedSession> {
    const id = input.id ?? this.activeSessionId;
    const session: PersistedSession = {
      ...input,
      id,
      createdAt: input.createdAt ?? Date.now(),
      workspaceId: input.workspaceId ?? this.workspaceId,
    };
    return this.store.upsert(session);
  }

  /** Persist the user input before the provider is called. */
  async saveTurnStart(
    input: SessionSnapshotInput & { content: MessageContent },
  ): Promise<PersistedSession> {
    const { content, messages, ...snapshot } = input;
    return this.save({
      ...snapshot,
      messages: [...messages, { role: "user", content }],
    });
  }

  /** Rebuild only the base prompt, retaining compact summaries in the log. */
  restoreHistory(session: PersistedSession, systemPrompt: string): AgentMessage[] {
    // `load()` already sanitizes the messages; avoid double-sanitization which
    // could drop messages in edge cases (e.g. when an interrupted turn leaves
    // the `discardUntilUser` flag active across the second pass).
    return restoreAgentHistory(session.messages, systemPrompt);
  }
}
