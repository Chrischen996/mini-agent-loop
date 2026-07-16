import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "./types.ts";

type SessionCreatedEvent = {
  type: "session_created";
  sessionId: string;
  createdAt: number;
};

type SessionSnapshotEvent = {
  type: "session_snapshot";
  sessionId: string;
  createdAt: number;
  messages: AgentMessage[];
};

type SessionEvent = SessionCreatedEvent | SessionSnapshotEvent;

export type PersistedSession = {
  id: string;
  createdAt: number;
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

export class SessionStore {
  private readonly root: string;

  constructor(dataDir?: string) {
    this.root = path.resolve(
      dataDir ?? process.env.AGENT_DATA_DIR ?? path.join(os.homedir(), ".mini-agent", "sessions"),
    );
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
              messages: [],
            };
          } else if (Array.isArray(parsed.messages)) {
            current = {
              id: parsed.sessionId,
              createdAt: parsed.createdAt,
              messages: parsed.messages,
            };
          }
        } catch {
          // Ignore one malformed JSONL record and recover later snapshots.
        }
      }
      if (current) sessions.set(current.id, current);
    }
    return sessions;
  }

  async create(session: PersistedSession): Promise<void> {
    await this.append({
      type: "session_created",
      sessionId: session.id,
      createdAt: session.createdAt,
    });
    await this.save(session);
  }

  async save(session: PersistedSession): Promise<void> {
    await this.append({
      type: "session_snapshot",
      sessionId: session.id,
      createdAt: session.createdAt,
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
