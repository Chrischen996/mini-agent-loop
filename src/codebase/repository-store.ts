import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { parseRepositoryRef, repositoryCloneUrl, type RepositoryRef } from "./repository-ref.ts";
import type { CodebaseHandle, CodebaseEvidence } from "./types.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_FILE_BYTES = 256 * 1024;
const DEFAULT_RESULT_BYTES = 100 * 1024;
const DEFAULT_CACHE_BYTES = 1024 * 1024 * 1024;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type RepositoryStoreOptions = {
  rootDir?: string;
  maxFileBytes?: number;
  maxResultBytes?: number;
  maxCacheBytes?: number;
  cacheTtlMs?: number;
  timeoutMs?: number;
  cloneUrl?: (repository: string) => string;
  now?: () => number;
};

function limitText(text: string, max: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= max) return text;
  let end = max;
  while (end > 0 && (buffer[end - 1]! & 0xc0) === 0x80) end -= 1;
  if (end > 0 && (buffer[end - 1]! & 0x80) !== 0) {
    const lead = buffer[end - 1]!;
    const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (max - (end - 1) < expected) end -= 1;
  }
  return `${buffer.subarray(0, end).toString("utf8")}\n[truncated]`;
}

async function directorySize(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(target);
    else if (entry.isFile()) total += (await stat(target)).size;
  }
  return total;
}

function positiveNumber(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

export function repositoryStoreOptionsFromEnv(rootDir?: string): RepositoryStoreOptions {
  return {
    rootDir,
    timeoutMs: positiveNumber("EXTERNAL_CODEBASE_FETCH_TIMEOUT_MS", process.env.EXTERNAL_CODEBASE_FETCH_TIMEOUT_MS, 60_000),
    maxFileBytes: positiveNumber("EXTERNAL_CODEBASE_MAX_FILE_BYTES", process.env.EXTERNAL_CODEBASE_MAX_FILE_BYTES, DEFAULT_FILE_BYTES),
    maxResultBytes: positiveNumber("EXTERNAL_CODEBASE_MAX_RESULT_BYTES", process.env.EXTERNAL_CODEBASE_MAX_RESULT_BYTES, DEFAULT_RESULT_BYTES),
    maxCacheBytes: positiveNumber("EXTERNAL_CODEBASE_MAX_CACHE_BYTES", process.env.EXTERNAL_CODEBASE_MAX_CACHE_BYTES, DEFAULT_CACHE_BYTES),
    cacheTtlMs: positiveNumber("EXTERNAL_CODEBASE_CACHE_TTL_HOURS", process.env.EXTERNAL_CODEBASE_CACHE_TTL_HOURS, 24) * 60 * 60 * 1000,
  };
}

export function createRepositoryStoreFromEnv(rootDir?: string): RepositoryStore {
  return new RepositoryStore(repositoryStoreOptionsFromEnv(rootDir));
}

export class RepositoryStore {
  private readonly rootDir: string;
  private readonly maxFileBytes: number;
  private readonly maxResultBytes: number;
  private readonly maxCacheBytes: number;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly cloneUrl: (repository: string) => string;
  private readonly now: () => number;
  private readonly handles = new Map<string, CodebaseHandle>();
  private readonly opens = new Map<string, Promise<CodebaseHandle>>();
  private readonly repositoryOperations = new Map<string, Promise<unknown>>();

  constructor(options: RepositoryStoreOptions = {}) {
    this.rootDir = options.rootDir ?? path.join(os.homedir(), ".mini-agent", "codebases");
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_FILE_BYTES;
    this.maxResultBytes = options.maxResultBytes ?? DEFAULT_RESULT_BYTES;
    this.maxCacheBytes = options.maxCacheBytes ?? DEFAULT_CACHE_BYTES;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.cloneUrl = options.cloneUrl ?? repositoryCloneUrl;
    this.now = options.now ?? Date.now;
  }

  private async git(args: string[], cwd?: string, signal?: AbortSignal): Promise<string> {
    try {
      const gitArgs = [
        "-c", "credential.helper=",
        "-c", `core.hooksPath=${os.devNull}`,
        "-c", "filter.lfs.smudge=",
        "-c", "filter.lfs.required=false",
        ...args,
      ];
      const result = await execFileAsync("git", gitArgs, {
        cwd,
        timeout: this.timeoutMs,
        maxBuffer: args[0] === "grep" ? this.maxResultBytes + 4096 : this.maxResultBytes + this.maxFileBytes + 4096,
        signal,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_LFS_SKIP_SMUDGE: "1",
          GIT_CONFIG_GLOBAL: os.devNull,
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      return result.stdout;
    } catch (error) {
      if (args[0] === "grep" && typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 1) return "";
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Git operation failed: ${message}`);
    }
  }

  private cachePath(repository: string): string {
    return path.join(this.rootDir, `${createHash("sha256").update(repository).digest("hex")}.git`);
  }

  private activeCachePaths(): Set<string> {
    return new Set([...this.handles.values()].map((handle) => this.cachePath(handle.repository)));
  }

  private async cacheEntries(): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
    let entries;
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT") return [];
      throw error;
    }
    const result: Array<{ path: string; size: number; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[0-9a-f]{64}\.git$/.test(entry.name)) continue;
      const target = path.join(this.rootDir, entry.name);
      const info = await lstat(target);
      result.push({ path: target, size: await directorySize(target), mtimeMs: info.mtimeMs });
    }
    return result;
  }

  private async evictFor(incomingBytes: number, keepPath: string): Promise<void> {
    const active = this.activeCachePaths();
    active.add(keepPath);
    const entries = await this.cacheEntries();
    const expired = entries.filter((entry) => !active.has(entry.path) && this.now() - entry.mtimeMs >= this.cacheTtlMs);
    for (const entry of expired) await rm(entry.path, { recursive: true, force: true });

    const remaining = (await this.cacheEntries()).filter((entry) => !active.has(entry.path)).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = (await this.cacheEntries()).reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of remaining) {
      if (total + incomingBytes <= this.maxCacheBytes) break;
      await rm(entry.path, { recursive: true, force: true });
      total -= entry.size;
    }
    if (total + incomingBytes > this.maxCacheBytes) throw new Error(`Repository cache exceeds ${this.maxCacheBytes} byte limit`);
  }

  private async serializeRepository<T>(repository: string, task: () => Promise<T>): Promise<T> {
    const previous = this.repositoryOperations.get(repository) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.repositoryOperations.set(repository, current);
    try {
      return await current;
    } finally {
      if (this.repositoryOperations.get(repository) === current) this.repositoryOperations.delete(repository);
    }
  }

  async open(input: string, explicitRef?: string, signal?: AbortSignal): Promise<CodebaseHandle> {
    const parsed = parseRepositoryRef(input, explicitRef);
    const key = `${parsed.repository}:${parsed.ref ?? "HEAD"}`;
    const existing = this.opens.get(key);
    if (existing) return existing;
    const promise = this.serializeRepository(parsed.repository, () => this.openParsed(parsed, signal)).finally(() => this.opens.delete(key));
    this.opens.set(key, promise);
    return promise;
  }

  private async openParsed(parsed: RepositoryRef, signal?: AbortSignal): Promise<CodebaseHandle> {
    const directory = this.cachePath(parsed.repository);
    await mkdir(this.rootDir, { recursive: true });
    let usable = false;
    try {
      const info = await lstat(directory);
      const active = [...this.handles.values()].some((handle) => handle.repository === parsed.repository);
      usable = info.isDirectory() && (active || this.now() - info.mtimeMs < this.cacheTtlMs);
    } catch {
      usable = false;
    }
    if (!usable) {
      await rm(directory, { recursive: true, force: true });
      const temporary = `${directory}.tmp-${randomUUID()}`;
      try {
        await this.git(["clone", "--bare", "--depth", "1", "--no-tags", this.cloneUrl(parsed.repository), temporary], undefined, signal);
        const size = await directorySize(temporary);
        if (size > this.maxCacheBytes) throw new Error(`Repository cache exceeds ${this.maxCacheBytes} byte limit`);
        await this.evictFor(size, directory);
        await rename(temporary, directory);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
    let revision: string;
    try {
      revision = (await this.git(["rev-parse", `${parsed.ref ?? "HEAD"}^{commit}`], directory, signal)).trim();
    } catch (error) {
      if (!parsed.ref) throw error;
      await this.git(["fetch", "--depth", "1", "--no-tags", "origin", parsed.ref], directory, signal);
      revision = (await this.git(["rev-parse", "FETCH_HEAD^{commit}"], directory, signal)).trim();
    }
    await this.evictFor(0, directory);
    if (await directorySize(directory) > this.maxCacheBytes) throw new Error(`Repository cache exceeds ${this.maxCacheBytes} byte limit`);
    if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Unable to resolve repository revision");
    const now = new Date(this.now());
    await utimes(directory, now, now);
    const handle = { handle: `repo_${randomUUID()}`, repository: parsed.repository, revision, provider: "git" as const };
    this.handles.set(handle.handle, handle);
    return handle;
  }

  get(handle: string): CodebaseHandle {
    const value = this.handles.get(handle);
    if (!value) throw new Error("Unknown codebase handle");
    return value;
  }

  async read(handleId: string, filePath: string, offset = 1, limit = 200, signal?: AbortSignal): Promise<CodebaseEvidence> {
    const handle = this.get(handleId);
    if (!filePath || filePath.includes("\\") || path.posix.isAbsolute(filePath) || filePath.split("/").includes("..")) throw new Error("Invalid repository path");
    const size = Number((await this.git(["cat-file", "-s", `${handle.revision}:${filePath}`], this.cachePath(handle.repository), signal)).trim());
    if (size > this.maxFileBytes) throw new Error(`File exceeds ${this.maxFileBytes} byte limit`);
    const content = await this.git(["show", `${handle.revision}:${filePath}`], this.cachePath(handle.repository), signal);
    const lines = content.split("\n");
    const start = Math.max(1, offset);
    const selected = lines.slice(start - 1, start - 1 + Math.max(1, Math.min(limit, 1000)));
    return { provider: "git", repository: handle.repository, revision: handle.revision, path: filePath, startLine: start, endLine: start + selected.length - 1, content: limitText(selected.join("\n"), this.maxResultBytes), generated: false };
  }

  async search(handleId: string, pattern: string, searchPath?: string, limit = 50, signal?: AbortSignal): Promise<CodebaseEvidence[]> {
    const handle = this.get(handleId);
    if (!pattern || pattern.length > 500) throw new Error("Search pattern is empty or too long");
    if (searchPath && (searchPath.includes("\\") || path.posix.isAbsolute(searchPath) || searchPath.split("/").includes(".."))) throw new Error("Invalid repository path");
    const args = ["grep", "-n", "-I", "-E", "--max-count", "1000", "-e", pattern, handle.revision, "--"];
    if (searchPath) args.push(searchPath);
    const output = await this.git(args, this.cachePath(handle.repository), signal);
    return output.split("\n").filter(Boolean).slice(0, Math.max(1, Math.min(limit, 100))).map((line) => {
      const evidenceLine = line.startsWith(`${handle.revision}:`) ? line.slice(handle.revision.length + 1) : line;
      const match = evidenceLine.match(/^([^:]+):(\d+):(.*)$/);
      const filePath = match?.[1] ?? evidenceLine.split(":", 1)[0]!;
      const lineNumber = match ? Number(match[2]) : undefined;
      return { provider: "git", repository: handle.repository, revision: handle.revision, path: filePath, startLine: lineNumber, endLine: lineNumber, content: limitText(match?.[3] ?? evidenceLine, this.maxResultBytes), generated: false };
    });
  }

  async close(): Promise<void> {
    this.handles.clear();
  }
}
