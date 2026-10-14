import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type WorkspaceRecord = { id: string; name: string; path: string };

/** Explicitly registered local roots available to Web sessions. */
export class WorkspaceRegistry {
  private readonly records = new Map<string, WorkspaceRecord>();
  private readonly file: string;
  private readonly initialPath: string;
  private defaultId: string;

  constructor(dataDir: string, initialPath: string) {
    this.file = path.join(dataDir, "workspaces.json");
    this.initialPath = path.resolve(initialPath);
    const root = this.initialPath;
    const id = this.idFor(root);
    this.defaultId = id;
    this.records.set(id, { id, name: path.basename(root) || root, path: root });
  }

  get defaultWorkspace(): WorkspaceRecord {
    return this.records.get(this.defaultId)!;
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    let saved: unknown[] = [];
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (Array.isArray(parsed)) saved = parsed;
    } catch {
      // A missing or malformed registry is rebuilt from the configured root.
    }
    this.records.clear();
    this.defaultId = (await this.add(this.initialPath)).id;
    for (const item of saved) {
      if (!item || typeof item !== "object") continue;
      const savedWorkspace = item as { path?: unknown };
      if (typeof savedWorkspace.path !== "string") continue;
      try {
        await this.add(savedWorkspace.path);
      } catch {
        // Skip workspaces whose directories are no longer available.
      }
    }
    await this.persist();
  }

  list(): WorkspaceRecord[] {
    return [...this.records.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string | undefined): WorkspaceRecord | undefined {
    return id ? this.records.get(id) : undefined;
  }

  findByPath(value: string): WorkspaceRecord | undefined {
    const resolved = path.resolve(value);
    return [...this.records.values()].find((item) => item.path === resolved);
  }

  async add(value: string): Promise<WorkspaceRecord> {
    const root = await realpath(path.resolve(value));
    if (!(await stat(root)).isDirectory()) throw new Error("Workspace path must be a directory");
    const existing = this.findByPath(root);
    if (existing) return existing;
    const id = this.idFor(root);
    const record = { id, name: path.basename(root) || root, path: root };
    this.records.set(id, record);
    await this.persist();
    return record;
  }

  private idFor(root: string): string {
    return createHash("sha256").update(root).digest("hex").slice(0, 20);
  }

  private async persist(): Promise<void> {
    const temporaryFile = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryFile, `${JSON.stringify(this.list(), null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryFile, this.file);
    } catch (error) {
      await rm(temporaryFile, { force: true });
      throw error;
    }
  }
}
