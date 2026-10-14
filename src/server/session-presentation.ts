import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Express } from "express";

export type SessionPresentation = { title: string; pinned: boolean; archived: boolean };
export type SessionPresentationPatch = Partial<SessionPresentation>;
const empty = (): SessionPresentation => ({ title: "", pinned: false, archived: false });

/** Web navigation metadata is separate from the agent transcript and permissions. */
export class SessionPresentationStore {
  private records = new Map<string, SessionPresentation>();
  private pending = Promise.resolve();
  private readonly file: string;
  constructor(dataDir: string) { this.file = path.join(dataDir, "session-presentation.json"); }
  async load(): Promise<void> {
    try {
      const data: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (!Array.isArray(data)) return;
      for (const item of data) {
        if (!item || typeof item !== "object" || typeof item.id !== "string") continue;
        this.records.set(item.id, {
          title: typeof item.title === "string" ? item.title.slice(0, 200) : "",
          pinned: item.pinned === true, archived: item.archived === true,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  get(id: string): SessionPresentation { return { ...(this.records.get(id) ?? empty()) }; }
  update(id: string, patch: SessionPresentationPatch): Promise<SessionPresentation> {
    let result = empty();
    const operation = this.pending.then(async () => {
      const next = new Map(this.records);
      result = { ...this.get(id), ...patch };
      next.set(id, result);
      await this.persist(next);
      this.records = next;
    });
    this.pending = operation.catch(() => {});
    return operation.then(() => ({ ...result }));
  }
  remove(id: string): Promise<void> {
    const operation = this.pending.then(async () => {
      const next = new Map(this.records); next.delete(id);
      await this.persist(next); this.records = next;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  private async persist(records: Map<string, SessionPresentation>): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify([...records].map(([id, value]) => ({ id, ...value }))), { mode: 0o600 });
      await rename(temporary, this.file);
    } finally { await rm(temporary, { force: true }); }
  }
}

export function registerSessionPresentationRoutes(app: Express, context: {
  hasSession: (id: string) => boolean; store: SessionPresentationStore;
}): void {
  app.patch("/api/sessions/:id/presentation", async (request, response) => {
    if (!context.hasSession(request.params.id)) { response.status(404).json({ error: "Session not found" }); return; }
    const body: unknown = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) { response.status(400).json({ error: "Expected a presentation object" }); return; }
    const patch = body as Record<string, unknown>;
    if (Object.keys(patch).some((key) => !["title", "pinned", "archived"].includes(key)) ||
      (patch.title !== undefined && (typeof patch.title !== "string" || patch.title.length > 200)) ||
      (patch.pinned !== undefined && typeof patch.pinned !== "boolean") ||
      (patch.archived !== undefined && typeof patch.archived !== "boolean")) {
      response.status(400).json({ error: "title must be at most 200 characters; pinned and archived must be booleans" }); return;
    }
    response.json(await context.store.update(request.params.id, {
      ...(typeof patch.title === "string" ? { title: patch.title.trim() } : {}),
      ...(typeof patch.pinned === "boolean" ? { pinned: patch.pinned } : {}),
      ...(typeof patch.archived === "boolean" ? { archived: patch.archived } : {}),
    }));
  });
}
