import {
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  isIgnoredName,
  resolveWorkspacePath,
  resolveWorkspaceWritePath,
} from "../workspace.ts";
import type { Tool, ToolResult } from "./types.ts";

type PathArgs = { path: string };
type SearchArgs = { query: string; path?: string; maxResults?: number };
type TransferArgs = { source: string; destination: string; overwrite?: boolean };
type PatchArgs = { path: string; oldText: string; newText: string; expectedReplacements?: number };
type EditArgs = { path: string; edits: Array<{ oldText: string; newText: string }> };
type GrepArgs = {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
};
type FindArgs = { pattern: string; path?: string; limit?: number };
type LsArgs = { path?: string; limit?: number };

const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_PATCH_BYTES = 512 * 1024;
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 1000;
const DEFAULT_LS_LIMIT = 500;

function result(content: string, isError = false): ToolResult {
  return isError ? { content, isError: true } : { content };
}

function validatePath(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isProtectedRelative(relativePath: string): boolean {
  return relativePath
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .some((segment) => segment === ".git" || segment === "node_modules");
}

async function existingFile(cwd: string, relativePath: string) {
  const resolved = await resolveWorkspacePath(cwd, relativePath);
  if (!resolved.ok) return resolved;
  const info = await stat(resolved.realTarget);
  if (!info.isFile()) {
    return { ok: false as const, error: `Path is not a file: ${relativePath}` };
  }
  return resolved;
}

async function existingEntry(cwd: string, relativePath: string) {
  const resolved = await resolveWorkspacePath(cwd, relativePath);
  if (!resolved.ok) return resolved;
  return resolved;
}

async function walkFiles(
  root: string,
  current: string,
  visit: (absolutePath: string, relativePath: string) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (isIgnoredName(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (await walkFiles(root, absolute, visit, signal)) return true;
    } else if (entry.isFile() && (await visit(absolute, relative))) {
      return true;
    }
  }
  return false;
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*" && pattern[i + 1] === "*") {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function matchesGlob(relativePath: string, pattern?: string): boolean {
  return !pattern || globToRegExp(pattern.replace(/\\/g, "/")).test(relativePath);
}

export function createLsTool(cwd: string): Tool<LsArgs> {
  return {
    name: "ls",
    description: "List directory contents, including dotfiles, sorted alphabetically.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list, default current directory" },
        limit: { type: "integer", minimum: 1, description: "Maximum entries, default 500" },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(args, signal) {
      if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
      const relativePath = validatePath(args.path) ?? ".";
      try {
        const resolved = await resolveWorkspacePath(cwd, relativePath);
        if (!resolved.ok) return result(resolved.error, true);
        const info = await stat(resolved.realTarget);
        if (!info.isDirectory()) return result(`Not a directory: ${relativePath}`, true);
        const limit = Math.max(1, args.limit ?? DEFAULT_LS_LIMIT);
        const entries = (await readdir(resolved.realTarget, { withFileTypes: true }))
          .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
          .slice(0, limit)
          .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name);
        const notice = entries.length < (await readdir(resolved.realTarget)).length ? `\n\n[${limit} entries limit reached]` : "";
        return result(entries.length ? entries.join("\n") + notice : "(empty directory)");
      } catch (error) {
        return result(`Failed to list ${relativePath}: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  };
}

export function createGrepTool(cwd: string): Tool<GrepArgs> {
  return {
    name: "grep",
    description: "Search file contents for a regex or literal pattern with paths, line numbers, glob filtering, and context.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search pattern (regex or literal string)" },
        path: { type: "string", description: "Directory or file to search" },
        glob: { type: "string", description: "File glob filter" },
        ignoreCase: { type: "boolean" },
        literal: { type: "boolean" },
        context: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: DEFAULT_GREP_LIMIT },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(args, signal) {
      if (!validatePath(args.pattern)) return result("pattern must be a non-empty string", true);
      const limit = Math.min(Math.max(args.limit ?? DEFAULT_GREP_LIMIT, 1), DEFAULT_GREP_LIMIT);
      let matcher: RegExp;
      try {
        const source = args.literal ? args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : args.pattern;
        matcher = new RegExp(source, args.ignoreCase ? "i" : "");
      } catch (error) {
        return result(`Invalid regex: ${error instanceof Error ? error.message : String(error)}`, true);
      }
      const output: string[] = [];
      const context = Math.max(0, args.context ?? 0);
      try {
        const start = validatePath(args.path) ?? ".";
        const resolved = await resolveWorkspacePath(cwd, start);
        if (!resolved.ok) return result(resolved.error, true);
        const visit = async (absolute: string, relative: string) => {
          if (output.length >= limit) return true;
          if (!matchesGlob(relative, args.glob)) return false;
          const file = await stat(absolute);
          if (file.size > MAX_SEARCH_FILE_BYTES) return false;
          const lines = (await readFile(absolute, "utf8")).split("\n");
          const matched = lines.map((line, index) => matcher.test(line) ? index : -1).filter((index) => index >= 0);
          for (const index of matched) {
            if (output.length >= limit) break;
            const from = Math.max(0, index - context);
            const to = Math.min(lines.length, index + context + 1);
            for (let i = from; i < to; i++) output.push(`${relative}:${i + 1}${i === index ? ":" : "-"} ${lines[i]}`);
          }
          return output.length >= limit;
        };
        const info = await stat(resolved.realTarget);
        if (info.isFile()) await visit(resolved.realTarget, resolved.relative || path.basename(resolved.realTarget));
        else if (info.isDirectory()) await walkFiles(resolved.realCwd, resolved.realTarget, visit, signal);
        else return result(`Unsupported path: ${start}`, true);
        return result(output.length ? output.join("\n") : "No matches");
      } catch (error) {
        return result(`Failed to grep: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  };
}

export function createFindTool(cwd: string): Tool<FindArgs> {
  return {
    name: "find",
    description: "Find files by glob pattern, respecting workspace boundaries and ignored directories.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, for example **/*.ts" },
        path: { type: "string", description: "Directory to search" },
        limit: { type: "integer", minimum: 1, maximum: DEFAULT_FIND_LIMIT },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(args, signal) {
      if (!validatePath(args.pattern)) return result("pattern must be a non-empty string", true);
      const found: string[] = [];
      const limit = Math.min(Math.max(args.limit ?? DEFAULT_FIND_LIMIT, 1), DEFAULT_FIND_LIMIT);
      try {
        const start = validatePath(args.path) ?? ".";
        const resolved = await resolveWorkspacePath(cwd, start);
        if (!resolved.ok) return result(resolved.error, true);
        const visit = async (absolute: string, relative: string) => {
          if (matchesGlob(relative, args.pattern)) found.push(relative);
          return found.length >= limit;
        };
        const info = await stat(resolved.realTarget);
        if (info.isFile()) await visit(resolved.realTarget, resolved.relative || path.basename(resolved.realTarget));
        else if (info.isDirectory()) await walkFiles(resolved.realCwd, resolved.realTarget, visit, signal);
        return result(found.length ? found.join("\n") : "No matches");
      } catch (error) {
        return result(`Failed to find files: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  };
}

export function createEditTool(cwd: string): Tool<EditArgs> {
  return {
    name: "edit",
    description: "Apply one or more exact, unique text replacements to a workspace file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        edits: { type: "array", items: { type: "object", properties: { oldText: { type: "string" }, newText: { type: "string" } }, required: ["oldText", "newText"], additionalProperties: false } },
      },
      required: ["path", "edits"],
      additionalProperties: false,
    },
    async execute(args) {
      if (!validatePath(args.path) || !Array.isArray(args.edits) || args.edits.length === 0) return result("path and a non-empty edits array are required", true);
      try {
        const file = await existingFile(cwd, args.path);
        if (!file.ok) return result(file.error, true);
        const current = await readFile(file.realTarget, "utf8");
        let updated = current;
        for (const edit of args.edits) {
          if (typeof edit.oldText !== "string" || typeof edit.newText !== "string" || !edit.oldText) return result("Each edit requires non-empty oldText and newText strings", true);
          const count = current.split(edit.oldText).length - 1;
          if (count !== 1) return result(`Edit oldText must match exactly once, found ${count}`, true);
          updated = updated.replace(edit.oldText, edit.newText);
        }
        await writeFile(file.realTarget, updated, "utf8");
        return result(`Successfully replaced ${args.edits.length} block(s) in ${file.relative}.`);
      } catch (error) {
        return result(`Failed to edit ${args.path}: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  };
}

export function createListTool(cwd: string): Tool<PathArgs> {
  return {
    name: "list",
    description: "List files and directories in the workspace or a relative directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path relative to workspace, default ." } },
      required: [],
      additionalProperties: false,
    },
    async execute(args) {
      const relativePath = validatePath(args.path) ?? ".";
      try {
        const resolved = await resolveWorkspacePath(cwd, relativePath);
        if (!resolved.ok) return result(resolved.error, true);
        const info = await stat(resolved.realTarget);
        if (!info.isDirectory()) return result(`Path is not a directory: ${relativePath}`, true);
        const entries = (await readdir(resolved.realTarget, { withFileTypes: true }))
          .filter((entry) => !isIgnoredName(entry.name))
          .map((entry) => `${entry.isDirectory() ? "dir" : "file"}\t${entry.name}`)
          .sort();
        return result(entries.length ? entries.join("\n") : "(empty directory)");
      } catch (error) {
        return result(`Failed to list ${relativePath}: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  };
}

export function createSearchTool(cwd: string): Tool<SearchArgs> {
  return {
    name: "search",
    description: "Search text in workspace files. Results include relative path and line number.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for" },
        path: { type: "string", description: "Optional file or directory path relative to workspace" },
        maxResults: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS, description: "Maximum matches" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args, signal) {
      if (!validatePath(args.query)) return result("query must be a non-empty string", true);
      const maxResults = Math.min(Math.max(args.maxResults ?? MAX_SEARCH_RESULTS, 1), MAX_SEARCH_RESULTS);
      const start = validatePath(args.path) ?? ".";
      try {
        const resolved = await resolveWorkspacePath(cwd, start);
        if (!resolved.ok) return result(resolved.error, true);
        const info = await stat(resolved.realTarget);
        const matches: string[] = [];
        const visit = async (absolute: string, relative: string) => {
          if (matches.length >= maxResults) return true;
          const file = await stat(absolute);
          if (file.size > MAX_SEARCH_FILE_BYTES) return false;
          const text = await readFile(absolute, "utf8");
          text.split("\n").forEach((line, index) => {
            if (matches.length < maxResults && line.includes(args.query)) {
              matches.push(`${relative}:${index + 1}: ${line}`);
            }
          });
          return matches.length >= maxResults;
        };
        if (info.isFile()) await visit(resolved.realTarget, resolved.relative || path.basename(resolved.realTarget));
        else if (info.isDirectory()) await walkFiles(resolved.realCwd, resolved.realTarget, visit, signal);
        else return result(`Unsupported path: ${start}`, true);
        return result(matches.length ? matches.join("\n") : "No matches");
      } catch (error) {
        return result(`Failed to search ${start}: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  };
}

export function createMkdirTool(cwd: string): Tool<PathArgs> {
  return {
    name: "mkdir",
    description: "Create a directory and its missing parent directories inside the workspace.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    async execute(args) {
      if (!validatePath(args.path) || args.path === ".") return result("path must be a non-empty directory path", true);
      try {
        if (isProtectedRelative(args.path)) return result(`Refusing to create protected path: ${args.path}`, true);
        const existing = await resolveWorkspacePath(cwd, args.path);
        if (existing.ok) {
          const info = await stat(existing.realTarget);
          return info.isDirectory()
            ? result(`Directory already exists: ${existing.relative}`)
            : result(`Path is a file: ${args.path}`, true);
        }
        const target = await resolveWorkspaceWritePath(cwd, args.path);
        if (!target.ok) return result(target.error, true);
        await mkdir(target.realTarget, { recursive: true });
        return result(`Created directory ${args.path}`);
      } catch (error) {
        return result(`Failed to create directory ${args.path}: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  };
}

export function createDeleteTool(cwd: string): Tool<PathArgs> {
  return {
    name: "delete",
    description: "Permanently delete a workspace file or directory. Protected paths are refused.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    async execute(args) {
      if (!validatePath(args.path) || args.path === ".") return result("Refusing to delete workspace root", true);
      try {
        const resolved = await existingEntry(cwd, args.path);
        if (!resolved.ok) return result(resolved.error, true);
        if (isProtectedRelative(resolved.relative)) return result(`Refusing to delete protected path: ${resolved.relative}`, true);
        await rm(resolved.realTarget, { recursive: true, force: false });
        return result(`Deleted ${resolved.relative}`);
      } catch (error) {
        return result(`Failed to delete ${args.path}: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  };
}

async function transfer(cwd: string, args: TransferArgs, operation: "move" | "copy"): Promise<ToolResult> {
  if (!validatePath(args.source) || !validatePath(args.destination)) return result("source and destination must be non-empty paths", true);
  const source = await existingEntry(cwd, args.source);
  if (!source.ok) return result(source.error, true);
  if (isProtectedRelative(source.relative)) return result(`Refusing to use protected source path: ${source.relative}`, true);
  const destination = await resolveWorkspaceWritePath(cwd, args.destination);
  if (!destination.ok) return result(destination.error, true);
  if (!args.overwrite) {
    try {
      await stat(destination.realTarget);
      return result(`Destination already exists: ${args.destination}`, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const parent = path.dirname(destination.realTarget);
  await mkdir(parent, { recursive: true });
  if (operation === "move") await rename(source.realTarget, destination.realTarget);
  else await cp(source.realTarget, destination.realTarget, { recursive: true, force: args.overwrite === true, errorOnExist: args.overwrite !== true });
  return result(`${operation === "move" ? "Moved" : "Copied"} ${source.relative} -> ${destination.relative}`);
}

export function createMoveTool(cwd: string): Tool<TransferArgs> {
  return {
    name: "move",
    description: "Move a workspace file or directory to another relative path.",
    parameters: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" }, overwrite: { type: "boolean" } }, required: ["source", "destination"], additionalProperties: false },
    async execute(args) { try { return await transfer(cwd, args, "move"); } catch (error) { return result(`Failed to move: ${error instanceof Error ? error.message : String(error)}`, true); } },
  };
}

export function createCopyTool(cwd: string): Tool<TransferArgs> {
  return {
    name: "copy",
    description: "Copy a workspace file or directory to another relative path.",
    parameters: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" }, overwrite: { type: "boolean" } }, required: ["source", "destination"], additionalProperties: false },
    async execute(args) { try { return await transfer(cwd, args, "copy"); } catch (error) { return result(`Failed to copy: ${error instanceof Error ? error.message : String(error)}`, true); } },
  };
}

export function createPatchTool(cwd: string): Tool<PatchArgs> {
  return {
    name: "patch",
    description: "Replace exact text in a UTF-8 workspace file. The match count must equal expectedReplacements (default 1).",
    parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" }, expectedReplacements: { type: "integer", minimum: 1 } }, required: ["path", "oldText", "newText"], additionalProperties: false },
    async execute(args) {
      if (!validatePath(args.path) || typeof args.oldText !== "string" || typeof args.newText !== "string") return result("path, oldText and newText are required", true);
      if (Buffer.byteLength(args.oldText, "utf8") > MAX_PATCH_BYTES || Buffer.byteLength(args.newText, "utf8") > MAX_PATCH_BYTES) return result(`patch text exceeds ${MAX_PATCH_BYTES} bytes`, true);
      try {
        const file = await existingFile(cwd, args.path);
        if (!file.ok) return result(file.error, true);
        const current = await readFile(file.realTarget, "utf8");
        const count = args.oldText === "" ? 0 : current.split(args.oldText).length - 1;
        const expected = args.expectedReplacements ?? 1;
        if (count !== expected) return result(`Expected ${expected} replacement(s), found ${count}`, true);
        const updated = current.split(args.oldText).join(args.newText);
        if (Buffer.byteLength(updated, "utf8") > MAX_PATCH_BYTES) return result(`result exceeds ${MAX_PATCH_BYTES} bytes`, true);
        await writeFile(file.realTarget, updated, "utf8");
        return result(`Patched ${file.relative} (${count} replacement${count === 1 ? "" : "s"})`);
      } catch (error) {
        return result(`Failed to patch ${args.path}: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  };
}
