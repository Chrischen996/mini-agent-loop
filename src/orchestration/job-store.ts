import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { OrchestrationJob } from "./types.ts";

export class JobStore {
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  private file(id: string): string {
    return path.join(this.root, `${id}.json`);
  }

  async save(job: OrchestrationJob): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const target = this.file(job.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const payload = JSON.stringify(job, null, 2);
    const previous = this.writes.get(job.id) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      await writeFile(temporary, payload, "utf8");
      await rename(temporary, target);
    });
    this.writes.set(job.id, write);
    try {
      await write;
    } finally {
      if (this.writes.get(job.id) === write) this.writes.delete(job.id);
    }
  }

  async get(id: string): Promise<OrchestrationJob | undefined> {
    try {
      return JSON.parse(await readFile(this.file(id), "utf8")) as OrchestrationJob;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<OrchestrationJob[]> {
    try {
      const names = (await readdir(this.root)).filter((name) => name.endsWith(".json"));
      const jobs = await Promise.all(names.map((name) => this.get(name.slice(0, -5))));
      return jobs.filter((job): job is OrchestrationJob => Boolean(job));
    } catch {
      return [];
    }
  }

  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }
}
