import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** Maximum retained records before LRU forgetting kicks in. */
const MAX_RECORDS = 500;

export type MemoryScope = "user" | "project" | "directory" | "task";
export type MemoryStatus = "candidate" | "confirmed" | "forgotten";

export type MemoryRecord = {
  id: string;
  scope: MemoryScope;
  key: string;
  content: string;
  status: MemoryStatus;
  source?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
};

export class MemoryStore {
  private records: MemoryRecord[] = [];
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      this.records = Array.isArray(parsed)
        ? parsed.filter((item): item is MemoryRecord => Boolean(
            item && typeof item === "object" && typeof (item as MemoryRecord).id === "string",
          ))
        : [];
    } catch {
      this.records = [];
    }
    this.loaded = true;
  }

  async list(options: { scope?: MemoryScope; includeForgotten?: boolean } = {}): Promise<MemoryRecord[]> {
    await this.load();
    return this.records.filter((record) =>
      (!options.scope || record.scope === options.scope) &&
      (options.includeForgotten || record.status !== "forgotten"),
    );
  }

  async search(query: string, options: { scope?: MemoryScope; limit?: number } = {}): Promise<MemoryRecord[]> {
    const needle = query.trim().toLowerCase();
    const records = await this.list({ scope: options.scope });
    const matches = records.filter((record) =>
      !needle || `${record.key}\n${record.content}`.toLowerCase().includes(needle),
    );
    const selected = matches.slice(0, options.limit ?? 20);
    if (selected.length > 0) {
      const now = Date.now();
      for (const record of selected) record.lastUsedAt = now;
      await this.persist();
    }
    return selected;
  }

  async add(input: Omit<MemoryRecord, "id" | "createdAt" | "updatedAt" | "status"> & { status?: MemoryStatus }): Promise<MemoryRecord> {
    await this.load();
    const now = Date.now();
    const record: MemoryRecord = {
      ...input,
      id: `mem_${now}_${randomUUID()}`,
      status: input.status ?? "candidate",
      createdAt: now,
      updatedAt: now,
    };
    this.records.push(record);
    await this.persist();
    return record;
  }

  /**
   * Create or update a memory identified by (scope, key). Used by the
   * turn-end auto-memory extractor so repeated observations of the same
   * fact refresh a single record instead of accumulating duplicates.
   */
  async upsertByKey(
    scope: MemoryScope,
    key: string,
    content: string,
    source?: string,
    status: MemoryStatus = "confirmed",
  ): Promise<MemoryRecord> {
    await this.load();
    const normalizedKey = key.trim().toLowerCase();
    const now = Date.now();
    const existing = this.records.find(
      (record) => record.scope === scope && record.key.toLowerCase() === normalizedKey && record.status !== "forgotten",
    );
    if (existing) {
      existing.content = content;
      existing.updatedAt = now;
      if (source) existing.source = source;
      await this.enforceCapacity();
      await this.persist();
      return existing;
    }
    const record = await this.add({ scope, key: normalizedKey, content, source, status });
    await this.enforceCapacity();
    return record;
  }

  /**
   * Cap total records; when exceeded, forget the least-recently-used
   * records until under the cap.
   */
  private async enforceCapacity(maxRecords = MAX_RECORDS): Promise<void> {
    if (this.records.length <= maxRecords) return;
    const excess = this.records.length - maxRecords;
    const byLru = [...this.records]
      .filter((record) => record.status !== "forgotten")
      .sort((a, b) => (a.lastUsedAt ?? a.updatedAt) - (b.lastUsedAt ?? b.updatedAt));
    for (const record of byLru.slice(0, excess)) {
      record.status = "forgotten";
      record.updatedAt = Date.now();
    }
  }

  async confirm(id: string): Promise<MemoryRecord | undefined> {
    return this.updateStatus(id, "confirmed");
  }

  async forget(id: string): Promise<MemoryRecord | undefined> {
    return this.updateStatus(id, "forgotten");
  }

  async buildPrompt(query: string, options: { scope?: MemoryScope; limit?: number } = {}): Promise<string> {
    const records = await this.search(query, options);
    const confirmed = records.filter((record) => record.status === "confirmed");
    if (confirmed.length === 0) return "";
    return [
      "### Confirmed Project Memory",
      ...confirmed.map((record) => `- ${record.key}: ${record.content}`),
    ].join("\n");
  }

  /**
   * Full memory digest for system-prompt injection (Claude Code-style
   * MEMORY.md index). Includes all non-forgotten records regardless of
   * confirmation status, capped by count.
   */
  async buildSystemMemoryPrompt(options: { limit?: number } = {}): Promise<string> {
    const records = await this.list({ includeForgotten: false });
    const selected = records
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, options.limit ?? 30);
    if (selected.length === 0) return "";
    return selected.map((record) => `- ${record.key}: ${record.content}`).join("\n");
  }

  private async updateStatus(id: string, status: MemoryStatus): Promise<MemoryRecord | undefined> {
    await this.load();
    const record = this.records.find((item) => item.id === id);
    if (!record) return undefined;
    record.status = status;
    record.updatedAt = Date.now();
    await this.persist();
    return record;
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = JSON.stringify(this.records, null, 2);
    const write = this.writeQueue.catch(() => undefined).then(async () => {
      await writeFile(temporary, payload, "utf8");
      await rename(temporary, this.filePath);
    });
    this.writeQueue = write;
    await write;
  }
}
