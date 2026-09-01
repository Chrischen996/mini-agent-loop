import { appendFile, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { contentAsString } from "./content.ts";
import type { AgentMessage } from "./types.ts";
import type { PermissionMode } from "./permissions.ts";
import type { ModelThinkingLevel } from "./pi-ai/types.ts";
import type { ThinkingMode } from "./thinking-policy.ts";
import type { SessionPhase, ExecutionPlan } from "./plan-act/types.ts";
import type { TodoItem } from "./tools/todo.ts";

type SessionCreatedEvent = {
  type: "session_created";
  sessionId: string;
  createdAt: number;
  modelId?: string;
  thinkingLevel?: ModelThinkingLevel;
  thinkingMode?: ThinkingMode;
  permissionMode?: PermissionMode;
  skillNames?: string[];
  phase?: SessionPhase;
  currentPlan?: ExecutionPlan;
  todos?: TodoItem[];
  todoVersion?: number;
  parentSessionId?: string;
  forkedFromMessage?: number;
  forkedFromMessageId?: string;
  workspaceId?: string;
};

type SessionSnapshotEvent = {
  type: "session_snapshot";
  sessionId: string;
  createdAt: number;
  /** Wall-clock time of the latest write; used for resume/recency ordering. */
  lastActiveAt?: number;
  modelId?: string;
  thinkingLevel?: ModelThinkingLevel;
  thinkingMode?: ThinkingMode;
  permissionMode?: PermissionMode;
  skillNames?: string[];
  phase?: SessionPhase;
  currentPlan?: ExecutionPlan | null;
  messages: AgentMessage[];
  todos?: TodoItem[];
  todoVersion?: number;
  parentSessionId?: string;
  forkedFromMessage?: number;
  forkedFromMessageId?: string;
  workspaceId?: string;
};

type SessionEvent = SessionCreatedEvent | SessionSnapshotEvent;

export type PersistedSession = {
  id: string;
  createdAt: number;
  /** Wall-clock time of the latest snapshot write (resume/recency ordering). */
  lastActiveAt?: number;
  modelId?: string;
  thinkingLevel?: ModelThinkingLevel;
  thinkingMode?: ThinkingMode;
  permissionMode?: PermissionMode;
  /** Currently active Skill names for this session. */
  skillNames?: string[];
  /** Current phase of the Plan-Act workflow. */
  phase?: SessionPhase;
  /** Currently active execution plan. */
  currentPlan?: ExecutionPlan;
  /** Stable project/workspace scope used to prevent cross-project resume. */
  workspaceId?: string;
  messages: AgentMessage[];
  todos?: TodoItem[];
  todoVersion?: number;
  parentSessionId?: string;
  forkedFromMessage?: number;
  forkedFromMessageId?: string;
};

/** Lightweight metadata for resume pickers (CLI `--resume`, TUI `/sessions`). */
export type PersistedSessionMeta = {
  id: string;
  createdAt: number;
  lastActiveAt: number;
  modelId?: string;
  messageCount: number;
  parentSessionId?: string;
  forkedFromMessageId?: string;
  workspaceId?: string;
  preview: string;
};

function isSessionEvent(value: unknown): value is SessionEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<SessionEvent>;
  return (
    (event.type === "session_created" || event.type === "session_snapshot") &&
    typeof event.sessionId === "string"
  );
}

export type SessionStoreOptions = {
  /** Maximum number of sessions to retain. Default: 100. */
  maxSessions?: number;
  /** Session time-to-live in milliseconds. Default: 30 days. */
  sessionTtlMs?: number;
  /**
   * Number of snapshot events tolerated in `events.jsonl` before the file is
   * rewritten to keep only the latest snapshot. Mirrors Claude Code's
   * transcript compaction: append-only writes stay cheap, while the file does
   * not grow without bound. Default: 20.
   */
  compactThreshold?: number;
  /** Only expose sessions belonging to this workspace when set. */
  workspaceId?: string;
};

const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000; // 30 days
const DEFAULT_COMPACT_THRESHOLD = 20;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

/**
 * Shared data root for persisted state (sessions, memory, documents).
 * Resolution: AGENT_DATA_DIR env → ~/.mini-agent. Mirrors the server default.
 */
export function getDataRoot(): string {
  return path.resolve(
    process.env.AGENT_DATA_DIR ?? path.join(os.homedir(), ".mini-agent"),
  );
}

export class SessionStore {
  private readonly root: string;
  private readonly maxSessions: number;
  private readonly sessionTtlMs: number;
  private readonly compactThreshold: number;
  private readonly workspaceId: string | undefined;
  /** Per-session snapshot-event counters to avoid re-reading files on save. */
  private readonly snapshotCounts = new Map<string, number>();

  constructor(dataDir?: string, options: SessionStoreOptions = {}) {
    this.root = path.resolve(
      dataDir ?? process.env.AGENT_DATA_DIR ?? path.join(os.homedir(), ".mini-agent", "sessions"),
    );
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.compactThreshold = options.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
    this.workspaceId = options.workspaceId;
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async loadAll(): Promise<Map<string, PersistedSession>> {
    await this.initialize();
    const sessions = new Map<string, PersistedSession>();
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return sessions;
    }

    for (const name of names) {
      if (!isValidSessionId(name)) continue;
      let parsed = await this.parseEventsFile(name);
      if (parsed && this.isLegacyUnscoped(parsed)) {
        parsed = await this.claimLegacy(parsed);
      }
      if (parsed && this.matchesWorkspace(parsed)) {
        sessions.set(parsed.id, parsed);
      }
    }
    // Evict expired and excess sessions on load
    await this.evict(sessions);
    return sessions;
  }

  /** Load a single session by id, or undefined when it does not exist. */
  async load(sessionId: string): Promise<PersistedSession | undefined> {
    if (!isValidSessionId(sessionId)) return undefined;
    let session = await this.parseEventsFile(sessionId);
    if (session && this.isLegacyUnscoped(session)) session = await this.claimLegacy(session);
    if (!session || !this.matchesWorkspace(session)) return undefined;
    if (this.isExpired(session)) {
      await this.remove(session.id).catch(() => {});
      return undefined;
    }
    return session;
  }

  /**
   * Lightweight session metadata for resume pickers (CLI `--resume`, TUI
   * `/sessions`). Ordered most-recently-active first.
   */
  async listSessions(): Promise<PersistedSessionMeta[]> {
    await this.initialize();
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return [];
    }

    const metas: PersistedSessionMeta[] = [];
    for (const name of names) {
      if (!isValidSessionId(name)) continue;
      const meta = await this.readMetaFile(name);
      if (meta && this.matchesWorkspace(meta)) {
        metas.push(meta);
        continue;
      }
      // Legacy sessions have no workspace binding (and older metadata may
      // also be unscoped). Read the transcript once so the first workspace
      // that opens the record can claim it safely under the session lock.
      if (!meta || meta.workspaceId === undefined) {
        let session = await this.parseEventsFile(name);
        if (session && this.isLegacyUnscoped(session)) session = await this.claimLegacy(session);
        if (session && this.matchesWorkspace(session)) metas.push(this.sessionMeta(session));
      }
    }

    const retention = this.retainSessionIds(metas);
    await Promise.all(retention.evictedIds.map((id) => this.remove(id).catch(() => {})));
    return metas
      .filter((meta) => retention.retainedIds.has(meta.id))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  /**
   * Remove sessions that exceed TTL or the max session count.
   * Deletes evicted sessions from disk and mutates the provided map.
   */
  async evict(sessions: Map<string, PersistedSession>): Promise<string[]> {
    const retention = this.retainSessionIds(sessions.values());
    for (const id of retention.evictedIds) sessions.delete(id);
    await Promise.all(retention.evictedIds.map((id) => this.remove(id).catch(() => {})));
    return retention.evictedIds;
  }

  async create(session: PersistedSession): Promise<void> {
    this.assertSessionId(session.id);
    await this.withSessionLock(session.id, async () => {
      if (await this.parseEventsFile(session.id)) {
        throw new Error(`Session already exists: ${session.id}`);
      }
      await this.createLocked(session);
    });
  }

  /**
   * Atomically create or update a session. Entry points use this for both
   * turn-start recovery checkpoints and turn-end snapshots, so a first write
   * cannot race another process into duplicate session_created records.
   */
  async upsert(session: PersistedSession): Promise<PersistedSession> {
    this.assertSessionId(session.id);
    let persisted: PersistedSession = session;
    await this.withSessionLock(session.id, async () => {
      const existing = await this.parseEventsFile(session.id);
      if (existing) {
        this.assertWritable(existing, session.id);
        persisted = {
          ...session,
          createdAt: existing.createdAt,
          workspaceId: session.workspaceId ?? existing.workspaceId ?? this.workspaceId,
          parentSessionId: session.parentSessionId ?? existing.parentSessionId,
          forkedFromMessage: session.forkedFromMessage ?? existing.forkedFromMessage,
          forkedFromMessageId: session.forkedFromMessageId ?? existing.forkedFromMessageId,
        };
        await this.saveLocked(persisted);
        return;
      }
      persisted = {
        ...session,
        workspaceId: session.workspaceId ?? this.workspaceId,
      };
      await this.createLocked(persisted);
    });
    return persisted;
  }

  private async createLocked(session: PersistedSession): Promise<void> {
    this.snapshotCounts.set(session.id, 0);
    await this.append({
      type: "session_created",
      sessionId: session.id,
      createdAt: session.createdAt,
      modelId: session.modelId,
      thinkingLevel: session.thinkingLevel,
      thinkingMode: session.thinkingMode,
      permissionMode: session.permissionMode,
      skillNames: session.skillNames,
      phase: session.phase,
      currentPlan: session.currentPlan,
      todos: session.todos,
      todoVersion: session.todoVersion,
      parentSessionId: session.parentSessionId,
      forkedFromMessage: session.forkedFromMessage,
      forkedFromMessageId: session.forkedFromMessageId,
      workspaceId: session.workspaceId ?? this.workspaceId,
    });
    await this.saveLocked(session);
  }

  async save(session: PersistedSession): Promise<void> {
    this.assertSessionId(session.id);
    await this.withSessionLock(session.id, async () => {
      const existing = await this.parseEventsFile(session.id);
      if (existing) this.assertWritable(existing, session.id);
      await this.saveLocked(session);
    });
  }

  private async saveLocked(session: PersistedSession): Promise<void> {
    this.ensureMessageIds(session.messages);
    const lastActiveAt = Date.now();
    await this.append({
      type: "session_snapshot",
      sessionId: session.id,
      createdAt: session.createdAt,
      lastActiveAt,
      modelId: session.modelId,
      thinkingLevel: session.thinkingLevel,
      thinkingMode: session.thinkingMode,
      permissionMode: session.permissionMode,
      skillNames: session.skillNames,
      phase: session.phase,
      currentPlan: session.currentPlan ?? null,
      messages: session.messages,
      todos: session.todos,
      todoVersion: session.todoVersion,
      parentSessionId: session.parentSessionId,
      forkedFromMessage: session.forkedFromMessage,
      forkedFromMessageId: session.forkedFromMessageId,
      workspaceId: session.workspaceId ?? this.workspaceId,
    });
    await this.writeMeta(this.sessionMeta({ ...session, lastActiveAt }));
    // Keep the append-only log bounded (Claude Code-style transcript compaction).
    const count = (this.snapshotCounts.get(session.id) ?? 0) + 1;
    this.snapshotCounts.set(session.id, count);
    if (count >= this.compactThreshold) {
      await this.compactLocked({ ...session, lastActiveAt });
    }
  }

  /**
   * Rewrite `events.jsonl` keeping only the latest snapshot. Append-only
   * writes stay the fast path; compaction is the rare exception.
   */
  async compact(session: PersistedSession): Promise<void> {
    this.assertSessionId(session.id);
    await this.withSessionLock(session.id, () => this.compactLocked(session));
  }

  private async compactLocked(session: PersistedSession): Promise<void> {
    this.ensureMessageIds(session.messages);
    const directory = path.join(this.root, session.id);
    await mkdir(directory, { recursive: true });
    const snapshot = JSON.stringify(this.snapshotEvent(session));
    await this.writeAtomic(path.join(directory, "events.jsonl"), `${snapshot}\n`);
    await this.writeMeta(this.sessionMeta(session));
    this.snapshotCounts.set(session.id, 1);
  }

  async clearMessages(sessionId: string, session: PersistedSession): Promise<void> {
    const clearedSession: PersistedSession = { ...session, messages: [] };
    await this.save(clearedSession);
  }

  async remove(sessionId: string): Promise<void> {
    this.assertSessionId(sessionId);
    await this.withSessionLock(sessionId, async () => {
      this.snapshotCounts.delete(sessionId);
      await rm(path.join(this.root, sessionId), { recursive: true, force: true });
    });
  }

  private snapshotEvent(session: PersistedSession): SessionSnapshotEvent {
    return {
      type: "session_snapshot",
      sessionId: session.id,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt ?? Date.now(),
      modelId: session.modelId,
      thinkingLevel: session.thinkingLevel,
      thinkingMode: session.thinkingMode,
      permissionMode: session.permissionMode,
      skillNames: session.skillNames,
      phase: session.phase,
      messages: session.messages,
      todos: session.todos,
      todoVersion: session.todoVersion,
      parentSessionId: session.parentSessionId,
      forkedFromMessage: session.forkedFromMessage,
      forkedFromMessageId: session.forkedFromMessageId,
      workspaceId: session.workspaceId ?? this.workspaceId,
      // null is intentional: it clears a previously persisted plan.
      currentPlan: session.currentPlan ?? null,
    };
  }

  private async parseEventsFile(name: string): Promise<PersistedSession | undefined> {
    const filePath = path.join(this.root, name, "events.jsonl");
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      return undefined;
    }

    let current: PersistedSession | undefined;
    let snapshotCount = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isSessionEvent(parsed) || parsed.sessionId !== name) continue;
        if (parsed.type === "session_created") {
          current ??= {
            id: parsed.sessionId,
            createdAt: parsed.createdAt,
            modelId: parsed.modelId,
            thinkingLevel: parsed.thinkingLevel,
            thinkingMode: parsed.thinkingMode,
            permissionMode: parsed.permissionMode,
            skillNames: parsed.skillNames,
            phase: parsed.phase,
            currentPlan: parsed.currentPlan,
            messages: [],
            todos: parsed.todos ?? [],
            todoVersion: parsed.todoVersion ?? 0,
            parentSessionId: parsed.parentSessionId,
            forkedFromMessage: parsed.forkedFromMessage,
            forkedFromMessageId: parsed.forkedFromMessageId,
            workspaceId: parsed.workspaceId,
          };
        } else if (Array.isArray(parsed.messages)) {
          snapshotCount += 1;
          current = {
            id: parsed.sessionId,
            createdAt: parsed.createdAt,
            lastActiveAt: parsed.lastActiveAt ?? current?.lastActiveAt,
            modelId: parsed.modelId ?? current?.modelId,
            thinkingLevel: parsed.thinkingLevel ?? current?.thinkingLevel,
            thinkingMode: parsed.thinkingMode ?? current?.thinkingMode,
            permissionMode: parsed.permissionMode ?? current?.permissionMode,
            skillNames: parsed.skillNames ?? current?.skillNames,
            phase: parsed.phase ?? current?.phase,
            currentPlan: parsed.currentPlan === null ? undefined : parsed.currentPlan ?? current?.currentPlan,
            messages: parsed.messages,
            todos: parsed.todos ?? current?.todos ?? [],
            todoVersion: parsed.todoVersion ?? current?.todoVersion ?? 0,
            parentSessionId: parsed.parentSessionId ?? current?.parentSessionId,
            forkedFromMessage: parsed.forkedFromMessage ?? current?.forkedFromMessage,
            forkedFromMessageId: parsed.forkedFromMessageId ?? current?.forkedFromMessageId,
            workspaceId: parsed.workspaceId ?? current?.workspaceId,
          };
        }
      } catch {
        // Ignore one malformed JSONL record and recover later snapshots.
      }
    }
    if (!current) return undefined;
    this.snapshotCounts.set(name, snapshotCount);
    this.ensureMessageIds(current.messages);
    return current;
  }

  private async append(event: SessionEvent): Promise<void> {
    const directory = path.join(this.root, event.sessionId);
    await mkdir(directory, { recursive: true });
    await appendFile(
      path.join(directory, "events.jsonl"),
      `${JSON.stringify(event)}\n`,
      "utf8",
    );
  }

  private matchesWorkspace(session: { workspaceId?: string }): boolean {
    return this.workspaceId === undefined || session.workspaceId === this.workspaceId;
  }

  private isLegacyUnscoped(session: { workspaceId?: string }): boolean {
    return this.workspaceId !== undefined && session.workspaceId === undefined;
  }

  private assertWritable(session: { workspaceId?: string }, sessionId: string): void {
    if (!this.matchesWorkspace(session) && !this.isLegacyUnscoped(session)) {
      throw new Error(`Cannot write session from another workspace: ${sessionId}`);
    }
  }

  /**
   * Older releases stored sessions in one global directory without a scope.
   * There is no historical workspace value to recover, so the first scoped
   * process that opens such a session claims it. The lock and compacted
   * snapshot make that claim visible to other processes before they resume it.
   */
  private async claimLegacy(session: PersistedSession): Promise<PersistedSession> {
    if (this.workspaceId === undefined || session.workspaceId !== undefined) return session;
    return this.withSessionLock(session.id, async () => {
      const latest = await this.parseEventsFile(session.id);
      if (!latest || latest.workspaceId !== undefined) return latest ?? session;
      const claimed = { ...latest, workspaceId: this.workspaceId };
      await this.compactLocked(claimed);
      return claimed;
    });
  }

  private sessionMeta(session: PersistedSession): PersistedSessionMeta {
    const firstUser = session.messages.find((message) => message.role === "user");
    return {
      id: session.id,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt ?? session.createdAt,
      modelId: session.modelId,
      messageCount: session.messages.length,
      parentSessionId: session.parentSessionId,
      forkedFromMessageId: session.forkedFromMessageId,
      workspaceId: session.workspaceId ?? this.workspaceId,
      preview: firstUser ? contentAsString(firstUser.content).slice(0, 80) : "",
    };
  }

  private async readMetaFile(name: string): Promise<PersistedSessionMeta | undefined> {
    try {
      const value = JSON.parse(
        await readFile(path.join(this.root, name, "meta.json"), "utf8"),
      ) as Partial<PersistedSessionMeta>;
      if (
        value.id !== name ||
        typeof value.createdAt !== "number" ||
        typeof value.lastActiveAt !== "number" ||
        typeof value.messageCount !== "number" ||
        typeof value.preview !== "string"
      ) return undefined;
      return {
        id: value.id,
        createdAt: value.createdAt,
        lastActiveAt: value.lastActiveAt,
        modelId: value.modelId,
        messageCount: value.messageCount,
        parentSessionId: value.parentSessionId,
        forkedFromMessageId: value.forkedFromMessageId,
        workspaceId: value.workspaceId,
        preview: value.preview,
      };
    } catch {
      return undefined;
    }
  }

  private async writeMeta(meta: PersistedSessionMeta): Promise<void> {
    await this.writeAtomic(
      path.join(this.root, meta.id, "meta.json"),
      `${JSON.stringify(meta)}\n`,
    );
  }

  /**
   * Backfill IDs for old transcripts and for callers that build messages
   * directly. The content plus visible position makes legacy IDs repeatable
   * across loads while preserving explicitly assigned IDs.
   */
  private ensureMessageIds(messages: AgentMessage[]): void {
    const seen = new Set<string>();
    for (const [index, message] of messages.entries()) {
      let id = message.id;
      if (!id || seen.has(id)) {
        const fingerprint = JSON.stringify({
          index,
          role: message.role,
          content: message.content,
          ...(message.role === "assistant" ? { toolCalls: message.toolCalls } : {}),
          ...(message.role === "tool"
            ? { toolCallId: message.toolCallId, name: message.name, isError: message.isError }
            : {}),
        });
        id = `msg_${createHash("sha256").update(fingerprint).digest("hex").slice(0, 24)}`;
        let suffix = 1;
        while (seen.has(id)) id = `${id}-${suffix++}`;
        message.id = id;
      }
      seen.add(id);
    }
  }

  private retainSessionIds(records: Iterable<{
    id: string;
    createdAt: number;
    lastActiveAt?: number;
  }>): {
    retainedIds: Set<string>;
    evictedIds: string[];
  } {
    const candidates = [...records];
    const now = Date.now();
    const active = candidates.filter((record) => {
      return !this.isExpired(record, now);
    });
    const activeIds = new Set(active.map((record) => record.id));
    const evictedIds = candidates
      .filter((record) => !activeIds.has(record.id))
      .map((record) => record.id);
    if (active.length > this.maxSessions) {
      const excess = [...active]
        .sort((a, b) => {
          const aLastActiveAt = a.lastActiveAt ?? a.createdAt;
          const bLastActiveAt = b.lastActiveAt ?? b.createdAt;
          return aLastActiveAt - bLastActiveAt;
        })
        .slice(0, active.length - this.maxSessions);
      evictedIds.push(...excess.map((record) => record.id));
    }
    const evictedSet = new Set(evictedIds);
    return {
      retainedIds: new Set(active.filter((record) => !evictedSet.has(record.id)).map((record) => record.id)),
      evictedIds,
    };
  }

  private isExpired(
    record: { createdAt: number; lastActiveAt?: number },
    now = Date.now(),
  ): boolean {
    const lastActiveAt = record.lastActiveAt ?? record.createdAt;
    return now - lastActiveAt > this.sessionTtlMs;
  }

  private async writeAtomic(filePath: string, contents: string): Promise<void> {
    const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(tempPath, contents, "utf8");
      await rename(tempPath, filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }

  private async withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    this.assertSessionId(sessionId);
    const directory = path.join(this.root, sessionId);
    const lockPath = path.join(directory, ".lock");
    await mkdir(directory, { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        await mkdir(lockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const lockStat = await stat(lockPath);
          if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
            await rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          // The owner may have released the lock between mkdir and stat.
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for session lock: ${sessionId}`);
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
    try {
      const heartbeat = setInterval(() => {
        void utimes(lockPath, new Date(), new Date()).catch(() => {});
      }, Math.max(1_000, Math.floor(LOCK_STALE_MS / 3)));
      heartbeat.unref?.();
      try {
        return await operation();
      } finally {
        clearInterval(heartbeat);
      }
    } finally {
      await rm(lockPath, { recursive: true, force: true }).catch(() => {});
    }
  }

  private assertSessionId(sessionId: string): void {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`Invalid session id: ${sessionId}`);
    }
  }
}
