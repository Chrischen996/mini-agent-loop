import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
  currentPlan?: ExecutionPlan;
  messages: AgentMessage[];
  todos?: TodoItem[];
  todoVersion?: number;
  parentSessionId?: string;
  forkedFromMessage?: number;
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
  messages: AgentMessage[];
  todos?: TodoItem[];
  todoVersion?: number;
  parentSessionId?: string;
  forkedFromMessage?: number;
};

/** Lightweight metadata for resume pickers (CLI `--resume`, TUI `/sessions`). */
export type PersistedSessionMeta = {
  id: string;
  createdAt: number;
  lastActiveAt: number;
  modelId?: string;
  messageCount: number;
  parentSessionId?: string;
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
  /** Session time-to-live in milliseconds. Default: 7 days (604_800_000). */
  sessionTtlMs?: number;
  /**
   * Number of snapshot events tolerated in `events.jsonl` before the file is
   * rewritten to keep only the latest snapshot. Mirrors Claude Code's
   * transcript compaction: append-only writes stay cheap, while the file does
   * not grow without bound. Default: 20.
   */
  compactThreshold?: number;
};

const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days
const DEFAULT_COMPACT_THRESHOLD = 20;

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
  /** Per-session snapshot-event counters to avoid re-reading files on save. */
  private readonly snapshotCounts = new Map<string, number>();

  constructor(dataDir?: string, options: SessionStoreOptions = {}) {
    this.root = path.resolve(
      dataDir ?? process.env.AGENT_DATA_DIR ?? path.join(os.homedir(), ".mini-agent", "sessions"),
    );
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.compactThreshold = options.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
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
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) continue;
      const parsed = await this.parseEventsFile(name);
      if (parsed) {
        sessions.set(parsed.id, parsed);
        this.snapshotCounts.set(parsed.id, Number.POSITIVE_INFINITY);
      }
    }
    // Evict expired and excess sessions on load
    await this.evict(sessions);
    return sessions;
  }

  /** Load a single session by id, or undefined when it does not exist. */
  async load(sessionId: string): Promise<PersistedSession | undefined> {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return undefined;
    return this.parseEventsFile(sessionId);
  }

  /**
   * Lightweight session metadata for resume pickers (CLI `--resume`, TUI
   * `/sessions`). Ordered most-recently-active first.
   */
  async listSessions(): Promise<PersistedSessionMeta[]> {
    const sessions = await this.loadAll();
    return [...sessions.values()]
      .map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt ?? session.createdAt,
        modelId: session.modelId,
        messageCount: session.messages.length,
        parentSessionId: session.parentSessionId,
        preview:
          session.messages.find((message) => message.role === "user") !== undefined
            ? contentAsString(
                session.messages.find((message) => message.role === "user")!.content,
              ).slice(0, 80)
            : "",
      }))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  /**
   * Remove sessions that exceed TTL or the max session count.
   * Deletes evicted sessions from disk and mutates the provided map.
   */
  async evict(sessions: Map<string, PersistedSession>): Promise<string[]> {
    const evictedIds: string[] = [];
    const now = Date.now();

    // 1. Remove sessions older than TTL
    for (const [id, session] of sessions) {
      if (now - session.createdAt > this.sessionTtlMs) {
        evictedIds.push(id);
        sessions.delete(id);
      }
    }

    // 2. Enforce maxSessions by removing least-recently-active first
    if (sessions.size > this.maxSessions) {
      const sorted = [...sessions.entries()].sort(
        (a, b) =>
          (a[1].lastActiveAt ?? a[1].createdAt) - (b[1].lastActiveAt ?? b[1].createdAt),
      );
      const excess = sorted.slice(0, sessions.size - this.maxSessions);
      for (const [id] of excess) {
        evictedIds.push(id);
        sessions.delete(id);
      }
    }

    // 3. Remove evicted sessions from disk in parallel
    await Promise.all(evictedIds.map((id) => this.remove(id).catch(() => {})));
    return evictedIds;
  }

  async create(session: PersistedSession): Promise<void> {
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
    });
    await this.save(session);
  }

  async save(session: PersistedSession): Promise<void> {
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
      currentPlan: session.currentPlan,
      messages: session.messages,
      todos: session.todos,
      todoVersion: session.todoVersion,
      parentSessionId: session.parentSessionId,
      forkedFromMessage: session.forkedFromMessage,
    });
    // Keep the append-only log bounded (Claude Code-style transcript compaction).
    const count = (this.snapshotCounts.get(session.id) ?? 0) + 1;
    this.snapshotCounts.set(session.id, count);
    if (count >= this.compactThreshold) {
      await this.compact({ ...session, lastActiveAt });
    }
  }

  /**
   * Rewrite `events.jsonl` keeping only the latest snapshot. Append-only
   * writes stay the fast path; compaction is the rare exception.
   */
  async compact(session: PersistedSession): Promise<void> {
    const directory = path.join(this.root, session.id);
    await mkdir(directory, { recursive: true });
    const snapshot = JSON.stringify(this.snapshotEvent(session));
    await writeFile(path.join(directory, "events.jsonl"), `${snapshot}\n`, "utf8");
    this.snapshotCounts.set(session.id, 1);
  }

  async clearMessages(sessionId: string, session: PersistedSession): Promise<void> {
    const clearedSession: PersistedSession = { ...session, messages: [] };
    await this.save(clearedSession);
  }

  async remove(sessionId: string): Promise<void> {
    this.snapshotCounts.delete(sessionId);
    await rm(path.join(this.root, sessionId), { recursive: true, force: true });
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
      currentPlan: session.currentPlan,
      messages: session.messages,
      todos: session.todos,
      todoVersion: session.todoVersion,
      parentSessionId: session.parentSessionId,
      forkedFromMessage: session.forkedFromMessage,
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
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isSessionEvent(parsed)) continue;
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
          };
        } else if (Array.isArray(parsed.messages)) {
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
            currentPlan: parsed.currentPlan ?? current?.currentPlan,
            messages: parsed.messages,
            todos: parsed.todos ?? current?.todos ?? [],
            todoVersion: parsed.todoVersion ?? current?.todoVersion ?? 0,
            parentSessionId: parsed.parentSessionId ?? current?.parentSessionId,
            forkedFromMessage: parsed.forkedFromMessage ?? current?.forkedFromMessage,
          };
        }
      } catch {
        // Ignore one malformed JSONL record and recover later snapshots.
      }
    }
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
}
