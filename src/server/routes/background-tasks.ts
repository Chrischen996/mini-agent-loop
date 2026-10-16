/** HTTP control surface for the persistent background task runtime. */

import type { Express, Request, Response } from "express";
import type {
  BgTaskSummary,
  LogChunk,
  SendTaskInput,
  StartTaskInput,
  WaitResult,
} from "../../bg-tasks/manager.js";
import { resolveWorkspacePath } from "../../workspace.ts";
import type { WorkspaceRecord } from "../../workspaces.ts";
import { errorMessage } from "./types.ts";

export type BackgroundTaskRuntime = {
  manager: BackgroundTaskManagerLike;
  initialize: () => Promise<void>;
};

/** Narrow manager contract so this route layer also works with process backends and test doubles. */
export type BackgroundTaskManagerLike = {
  list(): Promise<BgTaskSummary[]>;
  start(input: StartTaskInput): Promise<BgTaskSummary>;
  get(taskId: string): Promise<BgTaskSummary | undefined>;
  logs(taskId: string, offset?: number, limitBytes?: number): Promise<LogChunk>;
  screen(taskId: string, lines?: number): Promise<LogChunk>;
  send(taskId: string, input: SendTaskInput): Promise<BgTaskSummary>;
  terminate(taskId: string, force?: boolean): Promise<BgTaskSummary>;
  wait(taskIds: string[], mode?: "any" | "all", timeoutSeconds?: number): Promise<WaitResult>;
};

export type BackgroundTaskSession = {
  workspaceId?: string;
  cwd?: string;
};

export type BackgroundTaskRoutesContext = {
  workspace: string;
  enabled: boolean;
  getRuntime: (root: string) => BackgroundTaskRuntime | undefined;
  getSession: (id: string) => BackgroundTaskSession | undefined;
  getWorkspace: (id: string | undefined) => WorkspaceRecord | undefined;
  authorize?: (request: Request, toolName: "bg_start" | "bg_send" | "bg_kill", args: Record<string, unknown>) => Promise<void>;
};

type SelectedWorkspace = { root: string; workspaceId?: string };
type SelectionError = { status: number; error: string };

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requestValue(request: Request, key: string): unknown {
  if (request.method !== "GET" && request.body?.[key] !== undefined) return request.body[key];
  return request.query[key];
}

function selectWorkspace(
  context: BackgroundTaskRoutesContext,
  request: Request,
): SelectedWorkspace | SelectionError {
  const workspaceId = stringValue(requestValue(request, "workspaceId"));
  const sessionId = stringValue(requestValue(request, "sessionId"));
  const selected = context.getWorkspace(workspaceId);
  if (workspaceId && !selected) return { status: 404, error: "Workspace not found" };

  const session = sessionId ? context.getSession(sessionId) : undefined;
  if (sessionId && !session) return { status: 404, error: "Session not found" };
  if (session && workspaceId && session.workspaceId !== workspaceId) {
    return { status: 409, error: "Session and workspace scopes do not match" };
  }

  const sessionWorkspace = session?.workspaceId ? context.getWorkspace(session.workspaceId) : undefined;
  if (session && session.workspaceId && !sessionWorkspace) {
    return { status: 404, error: "Session workspace not found" };
  }
  const root = session?.cwd ?? sessionWorkspace?.path ?? selected?.path ?? context.workspace;
  return { root, workspaceId: sessionWorkspace?.id ?? selected?.id };
}

function sendSelectionError(response: Response, selection: SelectionError): false {
  response.status(selection.status).json({ error: selection.error });
  return false;
}

async function runtimeFor(
  context: BackgroundTaskRoutesContext,
  request: Request,
  response: Response,
): Promise<{ runtime: BackgroundTaskRuntime; workspace: SelectedWorkspace } | undefined> {
  if (!context.enabled) {
    response.status(404).json({ error: "Background tasks are disabled" });
    return undefined;
  }
  const selected = selectWorkspace(context, request);
  if ("status" in selected) {
    sendSelectionError(response, selected);
    return undefined;
  }
  const runtime = context.getRuntime(selected.root);
  if (!runtime) {
    response.status(404).json({ error: "Background tasks are disabled" });
    return undefined;
  }
  try {
    await runtime.initialize();
  } catch (error) {
    response.status(503).json({ error: errorMessage(error) });
    return undefined;
  }
  return { runtime, workspace: selected };
}

function parsePositiveInteger(value: unknown, name: string, max: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

function parseTaskIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.map((item) => validateTaskId(String(item).trim())).filter(Boolean);
  if (ids.length === 0 || ids.length > 50) throw new Error("taskIds must contain between 1 and 50 task IDs");
  return [...new Set(ids)];
}

/** Task IDs are generated by the manager; reject path separators before the store sees them. */
function validateTaskId(value: string): string {
  if (!/^bg_[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("invalid taskId");
  return value;
}

async function boundedCwd(root: string, value: unknown): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error("cwd must be a non-empty path");
  const resolved = await resolveWorkspacePath(root, value);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.realTarget;
}

function sendJsonError(response: Response, status: number, error: unknown): void {
  response.status(status).json({ error: errorMessage(error) });
}

async function authorizeMutation(
  context: BackgroundTaskRoutesContext,
  request: Request,
  response: Response,
  toolName: "bg_start" | "bg_send" | "bg_kill",
  args: Record<string, unknown>,
): Promise<boolean> {
  if (!context.authorize) return true;
  try {
    await context.authorize(request, toolName, args);
    return true;
  } catch (error) {
    response.status(403).json({ error: errorMessage(error) });
    return false;
  }
}

export function registerBackgroundTaskRoutes(
  app: Express,
  context: BackgroundTaskRoutesContext,
): void {
  app.get("/api/background-tasks", async (request, response) => {
    const selected = await runtimeFor(context, request, response);
    if (!selected) return;
    try {
      response.json({
        workspace: selected.workspace,
        tasks: await selected.runtime.manager.list(),
      });
    } catch (error) {
      sendJsonError(response, 400, error);
    }
  });

  app.post("/api/background-tasks", async (request, response) => {
    const selected = await runtimeFor(context, request, response);
    if (!selected) return;
    try {
      const command = stringValue(request.body?.command)?.trim() ?? "";
      if (!command) throw new Error("command is required");
      if (!await authorizeMutation(context, request, response, "bg_start", {
        command,
        ...(stringValue(request.body?.name)?.trim() ? { name: stringValue(request.body.name)!.trim() } : {}),
        ...(request.body?.cwd !== undefined ? { cwd: request.body.cwd } : {}),
        ...(request.body?.timeoutSeconds !== undefined ? { timeoutSeconds: request.body.timeoutSeconds } : {}),
      })) return;
      const taskInput: StartTaskInput = {
        command,
        ...(stringValue(request.body?.name)?.trim() ? { name: stringValue(request.body.name)!.trim() } : {}),
        ...(await boundedCwd(selected.workspace.root, request.body?.cwd)
          .then((cwd) => cwd ? { cwd } : {})),
        ...(request.body?.timeoutSeconds !== undefined
          ? { timeoutSeconds: parsePositiveInteger(request.body.timeoutSeconds, "timeoutSeconds", 604_800) }
          : {}),
      };
      const task = await selected.runtime.manager.start(taskInput);
      response.status(202).json({ task });
    } catch (error) {
      sendJsonError(response, 400, error);
    }
  });

  app.post("/api/background-tasks/wait", async (request, response) => {
    const selected = await runtimeFor(context, request, response);
    if (!selected) return;
    try {
      const taskIds = parseTaskIds(request.body?.taskIds);
      if (taskIds.length === 0) throw new Error("taskIds must contain between 1 and 50 task IDs");
      const mode = request.body?.mode === "any" ? "any" : "all";
      const timeoutSeconds = parsePositiveInteger(request.body?.timeoutSeconds, "timeoutSeconds", 86_400);
      const result = await selected.runtime.manager.wait(taskIds, mode, timeoutSeconds);
      response.json({ result });
    } catch (error) {
      sendJsonError(response, 400, error);
    }
  });

  app.get("/api/background-tasks/:taskId", async (request, response) => {
    const selected = await runtimeFor(context, request, response);
    if (!selected) return;
    try {
      const task = await selected.runtime.manager.get(validateTaskId(request.params.taskId));
      if (!task) {
        response.status(404).json({ error: "Task not found" });
        return;
      }
      response.json({ task });
    } catch (error) {
      sendJsonError(response, 400, error);
    }
  });

  app.get("/api/background-tasks/:taskId/logs", async (request, response) => {
    const selected = await runtimeFor(context, request, response);
    if (!selected) return;
    try {
      const source = request.query.source === "screen" ? "screen" : "log";
      const chunk: LogChunk = source === "screen"
        ? await selected.runtime.manager.screen(
          validateTaskId(request.params.taskId),
          parsePositiveInteger(request.query.screenLines, "screenLines", 500),
        )
        : await selected.runtime.manager.logs(
          validateTaskId(request.params.taskId),
          request.query.offset === undefined ? 0 : Number(request.query.offset),
          request.query.limitBytes === undefined ? 16_384 : Number(request.query.limitBytes),
        );
      response.json({ chunk });
    } catch (error) {
      sendJsonError(response, 400, error);
    }
  });

  app.post("/api/background-tasks/:taskId/input", async (request, response) => {
    const selected = await runtimeFor(context, request, response);
    if (!selected) return;
    try {
      const taskId = validateTaskId(request.params.taskId);
      const input: SendTaskInput = {
        ...(typeof request.body?.text === "string" ? { text: request.body.text } : {}),
        ...(request.body?.enter === true ? { enter: true } : {}),
      };
      if (!await authorizeMutation(context, request, response, "bg_send", { taskId, ...input })) return;
      const task = await selected.runtime.manager.send(taskId, input);
      response.json({ task });
    } catch (error) {
      sendJsonError(response, 400, error);
    }
  });

  app.post("/api/background-tasks/:taskId/kill", async (request, response) => {
    const selected = await runtimeFor(context, request, response);
    if (!selected) return;
    try {
      const taskId = validateTaskId(request.params.taskId);
      const force = request.body?.force === true;
      if (!await authorizeMutation(context, request, response, "bg_kill", { taskId, force })) return;
      const task = await selected.runtime.manager.terminate(taskId, force);
      response.json({ task });
    } catch (error) {
      sendJsonError(response, 400, error);
    }
  });
}

export type BackgroundTaskRoutePayloads = {
  task: BgTaskSummary;
  chunk: LogChunk;
  result: WaitResult;
};
