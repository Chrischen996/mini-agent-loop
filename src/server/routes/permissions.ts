/**
 * Per-session permission routes: mode inspection/changes and resolution of
 * pending tool-approval requests.
 */

import type { Express } from "express";
import {
  isPermissionMode,
  type PermissionDecision,
  type PermissionManager,
} from "../../permissions.ts";

/** Minimal session shape the permission routes rely on. */
export type PermissionRoutesSession = {
  id: string;
  permissionManager: PermissionManager;
};

export type PermissionRoutesContext<TSession extends PermissionRoutesSession> = {
  getSession: (id: string) => TSession | undefined;
  saveSession: (session: TSession) => Promise<void>;
};

export function registerPermissionRoutes<TSession extends PermissionRoutesSession>(
  app: Express,
  context: PermissionRoutesContext<TSession>,
): void {
  const { saveSession } = context;
  const sessions = { get: context.getSession };

  app.get("/api/sessions/:id/permission-mode", (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    response.json({ mode: session.permissionManager.getMode() });
  });

  app.put("/api/sessions/:id/permission-mode", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const mode = request.body?.mode;
    if (!isPermissionMode(mode)) {
      response.status(400).json({ error: "mode must be plan, approval, or bypass" });
      return;
    }
    const change = session.permissionManager.setMode(mode);
    await saveSession(session);
    response.json({
      mode: change.mode,
      previousMode: change.previousMode,
      changed: change.changed,
      interrupted: change.interrupted,
    });
  });

  app.post("/api/sessions/:id/permissions/:requestId", (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const decision = request.body?.decision;
    if (decision !== "allow" && decision !== "deny") {
      response.status(400).json({ error: "decision must be allow or deny" });
      return;
    }
    const resolved = session.permissionManager.resolve(
      session.id,
      request.params.requestId,
      decision as PermissionDecision,
    );
    if (!resolved) {
      response.status(404).json({ error: "Permission request not found" });
      return;
    }
    response.json({ resolved: true, decision });
  });
}
