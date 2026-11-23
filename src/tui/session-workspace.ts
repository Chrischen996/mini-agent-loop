// Session workspace resolution.
//
// A saved session may execute from an isolated git worktree instead of the
// project root. These helpers resolve (and bound) that path before the TUI
// boots a session into it, so a stale or hostile `cwd` in a session file can
// never escape the project or an unregistered directory.

import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { GitWorkflow } from "../git/workflow.ts";
import { SessionManager } from "../session-manager.ts";
import type { StartupSessionRequest } from "./session-serialization.ts";

/**
 * Resolve the workspace a session should run in. Falls back to the project
 * root when the recorded path is missing, not a directory, outside the
 * project, or not a registered git worktree.
 */
export async function resolveSessionWorkspaceCwd(projectCwd: string, candidatePath?: string): Promise<string> {
  const root = await realpath(projectCwd).catch(() => path.resolve(projectCwd));
  const requested = path.resolve(candidatePath ?? root);
  let candidate: string;
  try {
    if (!(await stat(requested)).isDirectory()) return root;
    candidate = await realpath(requested);
  } catch {
    return root;
  }
  const relative = path.relative(root, candidate);
  if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    return candidate;
  }
  try {
    if (await new GitWorkflow(root).isRegisteredWorktree(candidate)) return candidate;
  } catch {
    // Missing or unregistered session paths fall back to the project root.
  }
  return root;
}

/** Resolve the workspace cwd for a startup resume/continue/fork request. */
export async function startupSessionCwd(projectCwd: string, request: StartupSessionRequest): Promise<string> {
  const manager = new SessionManager({ workspaceId: projectCwd });
  const session = request.sessionId
    ? await manager.load(request.sessionId)
    : request.resume || request.continueSession || request.fork
      ? await manager.loadMostRecent()
      : undefined;
  return resolveSessionWorkspaceCwd(projectCwd, session?.cwd);
}
