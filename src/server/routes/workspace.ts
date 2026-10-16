/**
 * `/api/health` and `/api/workspace/list` — liveness plus workspace browsing.
 */

import type { Express } from "express";
import { createReadStream } from "node:fs";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listWorkspaceDirectory, readWorkspaceFile, resolveWorkspacePath } from "../../workspace.ts";
import type { WorkspaceRegistry, WorkspaceRecord } from "../../workspaces.ts";
import { errorMessage } from "./types.ts";

/** One directory level in the add-workspace picker. Hidden rows count toward the bound. */
export const DIRECTORY_BROWSER_MAX_ENTRIES = 1000;

export type DirectoryBrowserEntry = {
  name: string;
  path: string;
  hidden: boolean;
};

export type DirectoryCrumb = { name: string; path: string };

/**
 * A picker path must name one fixed location. Relative paths are refused so a
 * wire value cannot be rebased onto the host process working directory.
 */
export function isFullyQualifiedDirectory(value: string): boolean {
  if (!value || value !== value.trim()) return false;
  if (process.platform === "win32") {
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
  }
  return path.isAbsolute(value);
}

export function directoryBreadcrumbs(current: string): DirectoryCrumb[] {
  const root = path.parse(current).root;
  const crumbs: DirectoryCrumb[] = [{ name: root, path: root }];
  if (current === root) return crumbs;
  const relative = path.relative(root, current);
  let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    crumbs.push({ name: part, path: cursor });
  }
  return crumbs;
}

function resolveDirectoryRequest(value: string | undefined): string | { error: string } {
  const requested = value?.trim();
  if (!requested) return os.homedir();
  if (requested === "~") return os.homedir();
  if (requested.startsWith("~/") || requested.startsWith("~\\")) {
    return path.join(os.homedir(), requested.slice(2));
  }
  if (!isFullyQualifiedDirectory(requested)) {
    return { error: "Directory path must be fully qualified" };
  }
  return requested;
}

export type WorkspaceRoutesContext = {
  workspace: string;
  registry: WorkspaceRegistry;
  getSession: (id: string) => { workspaceId?: string; cwd?: string } | undefined;
  getWorkspace: (id: string | undefined) => WorkspaceRecord | undefined;
};

function resolveRequestWorkspace(
  context: WorkspaceRoutesContext,
  sessionValue: unknown,
  workspaceValue: unknown,
): { root: string; workspaceId?: string } | { status: number; error: string } {
  const requestedWorkspaceId = typeof workspaceValue === "string" ? workspaceValue : undefined;
  const requestedWorkspace = context.getWorkspace(requestedWorkspaceId);
  if (requestedWorkspaceId && !requestedWorkspace) {
    return { status: 404, error: "Workspace not found" };
  }

  const sessionId = typeof sessionValue === "string" ? sessionValue : undefined;
  const session = sessionId ? context.getSession(sessionId) : undefined;
  if (sessionId && !session) return { status: 404, error: "Session not found" };

  if (session && requestedWorkspaceId) {
    const sessionWorkspace = context.getWorkspace(session.workspaceId);
    if (!sessionWorkspace || sessionWorkspace.id !== requestedWorkspaceId) {
      return { status: 409, error: "Session and workspace scopes do not match" };
    }
  }

  const selected = session
    ? context.getWorkspace(session.workspaceId)
    : requestedWorkspace;
  const root = session?.cwd ?? selected?.path ?? (session ? undefined : context.workspace);
  if (!root) return { status: 404, error: "Workspace not found" };
  return { root, workspaceId: selected?.id };
}

export function registerWorkspaceRoutes(app: Express, context: WorkspaceRoutesContext): void {
  app.get("/api/health", (_request, response) => response.json({ ok: true }));

  app.get("/api/workspaces", (_request, response) => {
    response.json({ workspaces: context.registry.list() });
  });

  app.post("/api/workspaces", async (request, response) => {
    const root = typeof request.body?.path === "string" ? request.body.path.trim() : "";
    if (!root) {
      response.status(400).json({ error: "path is required" });
      return;
    }
    try {
      response.status(201).json({ workspace: await context.registry.add(root) });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/workspaces/directories", async (request, response) => {
    const parent = resolveDirectoryRequest(typeof request.body?.path === "string" ? request.body.path : undefined);
    if (typeof parent !== "string") {
      response.status(400).json({ error: parent.error });
      return;
    }
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      response.status(400).json({ error: "Folder name must be a single path segment" });
      return;
    }
    try {
      const current = await realpath(path.resolve(parent));
      if (!(await stat(current)).isDirectory()) {
        response.status(400).json({ error: "Path must be a directory" });
        return;
      }
      const child = path.join(current, name);
      await mkdir(child);
      response.status(201).json({ path: await realpath(child) });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
      response.status(code === "EEXIST" ? 409 : 400).json({
        error: code === "EEXIST" ? "Folder already exists" : errorMessage(error),
      });
    }
  });

  app.get("/api/workspaces/directories", async (request, response) => {
    const requested = resolveDirectoryRequest(
      typeof request.query.path === "string" ? request.query.path : undefined,
    );
    if (typeof requested !== "string") {
      response.status(400).json({ error: requested.error });
      return;
    }
    try {
      const current = await realpath(path.resolve(requested));
      if (!(await stat(current)).isDirectory()) {
        response.status(400).json({ error: "Path must be a directory" });
        return;
      }
      const entries = await readdir(current, { withFileTypes: true });
      const directories: DirectoryBrowserEntry[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          directories.push({
            name: entry.name,
            path: path.join(current, entry.name),
            hidden: entry.name.startsWith("."),
          });
          continue;
        }
        if (!entry.isSymbolicLink()) continue;
        const child = path.join(current, entry.name);
        try {
          const target = await realpath(child);
          if ((await stat(target)).isDirectory()) {
            directories.push({ name: entry.name, path: target, hidden: entry.name.startsWith(".") });
          }
        } catch {
          // Skip broken or cyclic directory links.
        }
      }
      directories.sort((a, b) => a.name.localeCompare(b.name));
      const truncated = directories.length > DIRECTORY_BROWSER_MAX_ENTRIES;
      const parent = path.dirname(current);
      const home = os.homedir();
      response.json({
        path: current,
        parent: parent === current ? null : parent,
        home,
        crumbs: directoryBreadcrumbs(current),
        directories: truncated ? directories.slice(0, DIRECTORY_BROWSER_MAX_ENTRIES) : directories,
        truncated,
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/workspace/list", async (request, response) => {
    const relativePath = String(request.query.path ?? "");
    const scope = resolveRequestWorkspace(context, request.query.sessionId, request.query.workspaceId);
    if ("error" in scope) {
      response.status(scope.status).json({ error: scope.error });
      return;
    }
    try {
      response.json({ ...await listWorkspaceDirectory(scope.root, relativePath), workspaceId: scope.workspaceId });
    } catch (error) {
      const status =
        error && typeof error === "object" && "status" in error
          ? Number((error as { status: unknown }).status) || 400
          : 400;
      response.status(status).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/workspace/file", async (request, response) => {
    const relativePath = String(request.query.path ?? "");
    const scope = resolveRequestWorkspace(context, request.query.sessionId, request.query.workspaceId);
    if ("error" in scope) {
      response.status(scope.status).json({ error: scope.error });
      return;
    }
    try {
      const offset = request.query.offset === undefined ? undefined : Number(request.query.offset);
      const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
      response.json({
        ...await readWorkspaceFile(scope.root, relativePath, {
          offset: Number.isFinite(offset) ? offset : undefined,
          limit: Number.isFinite(limit) ? limit : undefined,
        }),
        workspaceId: scope.workspaceId,
      });
    } catch (error) {
      const status =
        error && typeof error === "object" && "status" in error
          ? Number((error as { status: unknown }).status) || 400
          : 400;
      response.status(status).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/workspace/raw", async (request, response) => {
    const relativePath = String(request.query.path ?? "");
    const scope = resolveRequestWorkspace(context, request.query.sessionId, request.query.workspaceId);
    if ("error" in scope) {
      response.status(scope.status).json({ error: scope.error });
      return;
    }
    const resolved = await resolveWorkspacePath(scope.root, relativePath);
    if (!resolved.ok) {
      response.status(resolved.code === "ENOENT" ? 404 : 400).json({ error: resolved.error });
      return;
    }
    const info = await stat(resolved.realTarget).catch(() => null);
    if (!info?.isFile()) {
      response.status(400).json({ error: "Path is not a file" });
      return;
    }
    if (info.size > 8 * 1024 * 1024) {
      response.status(413).json({ error: "File is too large to preview" });
      return;
    }
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    createReadStream(resolved.realTarget).on("error", (error) => {
      if (!response.headersSent) response.status(404).json({ error: error.message });
      else response.destroy(error);
    }).pipe(response);
  });
}
