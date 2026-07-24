import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "./types.ts";

type SessionCreatedEvent = {
  type: "session_created";
  sessionId: string;
  createdAt: number;
  modelId?: string;
};

type SessionSnapshotEvent = {
  type: "session_snapshot";
  sessionId: string;
  createdAt: number;
  modelId?: string;
  messages: AgentMessage[];
};

type SessionEvent = SessionCreatedEvent | SessionSnapshotEvent;

export type PersistedSession = {
  id: string;
  createdAt: number;
  modelId?: string;
  messages: AgentMessage[];
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
};

const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days

export class SessionStore {
  private readonly root: string;
  private readonly maxSessions: number;
  private readonly sessionTtlMs: number;

  constructor(dataDir?: string, options: SessionStoreOptions = {}) {
    this.root = path.resolve(
      dataDir ?? process.env.AGENT_DATA_DIR ?? path.join(os.homedir(), ".mini-agent", "sessions"),
    );
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
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
      const filePath = path.join(this.root, name, "events.jsonl");
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch {
        continue;
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
              messages: [],
            };
          } else if (Array.isArray(parsed.messages)) {
            current = {
              id: parsed.sessionId,
              createdAt: parsed.createdAt,
              modelId: parsed.modelId ?? current?.modelId,
              messages: parsed.messages,
            };
          }
        } catch {
          // Ignore one malformed JSONL record and recover later snapshots.
        }
      }
      if (current) sessions.set(current.id, current);
    }
    // Evict expired and excess sessions on load
    await this.evict(sessions);
    return sessions;
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

    // 2. Enforce maxSessions by removing oldest first
    if (sessions.size > this.maxSessions) {
      const sorted = [...sessions.entries()]
        .sort((a, b) => a[1].createdAt - b[1].createdAt);
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
    await this.append({
      type: "session_created",
      sessionId: session.id,
      createdAt: session.createdAt,
      modelId: session.modelId,
    });
    await this.save(session);
  }

  async save(session: PersistedSession): Promise<void> {
    await this.append({
      type: "session_snapshot",
      sessionId: session.id,
      createdAt: session.createdAt,
      modelId: session.modelId,
      messages: session.messages,
    });
  }

  async remove(sessionId: string): Promise<void> {
    await rm(path.join(this.root, sessionId), { recursive: true, force: true });
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
