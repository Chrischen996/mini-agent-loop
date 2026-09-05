/**
 * `/api/health` and `/api/workspace/list` — liveness plus workspace browsing.
 */

import type { Express } from "express";
import { listWorkspaceDirectory } from "../../workspace.ts";
import { errorMessage } from "./types.ts";

export type WorkspaceRoutesContext = {
  workspace: string;
};

export function registerWorkspaceRoutes(app: Express, context: WorkspaceRoutesContext): void {
  app.get("/api/health", (_request, response) => response.json({ ok: true }));

  app.get("/api/workspace/list", async (request, response) => {
    const relativePath = String(request.query.path ?? "");
    try {
      response.json(await listWorkspaceDirectory(context.workspace, relativePath));
    } catch (error) {
      const status =
        error && typeof error === "object" && "status" in error
          ? Number((error as { status: unknown }).status) || 400
          : 400;
      response.status(status).json({ error: errorMessage(error) });
    }
  });
}
