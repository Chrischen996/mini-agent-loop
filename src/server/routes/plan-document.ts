/**
 * Session plan-document routes (`/api/sessions/:id/plan*`), backed by the
 * on-disk plan kernel rather than the in-memory Plan-Act manager.
 */

import type { Express } from "express";
import {
  approveCurrentPlan,
  archiveCurrentPlan,
  createAndSavePlan,
  editCurrentPlan,
  listPlanHistory,
  loadPlanDocument,
  rejectCurrentPlan,
} from "../../plan/index.ts";
import type { SessionExecutionLease } from "../../orchestration/session-gate.ts";
import { errorMessage } from "./types.ts";

/** Maps plan-kernel failures onto HTTP status codes. */
export function planHttpError(error: unknown): { status: number; message: string } {
  const message = errorMessage(error);
  if (/no (saved )?plan/i.test(message) || /no plan found/i.test(message)) {
    return { status: 404, message };
  }
  if (/not approved|rejected|cannot execute/i.test(message)) {
    return { status: 400, message };
  }
  return { status: 500, message };
}

export type PlanDocumentRoutesSession = { id: string };

export type PlanDocumentRoutesContext<TSession extends PlanDocumentRoutesSession> = {
  getSession: (id: string) => TSession | undefined;
  reserveSession: (session: TSession, owner: string) => SessionExecutionLease | undefined;
  releaseSession: (session: TSession, lease: SessionExecutionLease) => void;
  /** Resolves the on-disk plan root for a session. */
  sessionPlanRoot: (sessionId: string) => string;
};

export function registerPlanDocumentRoutes<TSession extends PlanDocumentRoutesSession>(
  app: Express,
  context: PlanDocumentRoutesContext<TSession>,
): void {
  const { reserveSession, releaseSession } = context;
  const sessions = { get: context.getSession };
  const planRootFor = context.sessionPlanRoot;

  app.get("/api/sessions/:id/plan", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const plan = await loadPlanDocument(planRootFor(session.id));
    response.json({ plan });
  });

  app.post("/api/sessions/:id/plan", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const prompt = typeof request.body?.prompt === "string" ? request.body.prompt.trim() : "";
    const planMarkdown = typeof request.body?.plan === "string" ? request.body.plan : "";
    if (!prompt) {
      response.status(400).json({ error: "prompt is required" });
      return;
    }
    if (!planMarkdown.trim()) {
      response.status(400).json({ error: "plan is required" });
      return;
    }
    const autoApprove = Boolean(request.body?.autoApprove);
    const lease = reserveSession(session, "plan:create");
    if (!lease) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    try {
      const planRoot = planRootFor(session.id);
      const plan = await createAndSavePlan(planRoot, prompt, planMarkdown, {
        autoApprove,
        approvedBy: autoApprove ? "api" : undefined,
      });
      response.status(201).json({ plan });
    } finally {
      releaseSession(session, lease);
    }
  });

  app.post("/api/sessions/:id/plan/approve", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const by = typeof request.body?.by === "string" && request.body.by.trim()
      ? request.body.by.trim()
      : "api";
    const lease = reserveSession(session, "plan:approve");
    if (!lease) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    try {
      const plan = await approveCurrentPlan(planRootFor(session.id), by);
      response.json({ plan });
    } catch (error) {
      const { status, message } = planHttpError(error);
      response.status(status).json({ error: message });
    } finally {
      releaseSession(session, lease);
    }
  });

  app.post("/api/sessions/:id/plan/reject", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const lease = reserveSession(session, "plan:reject");
    if (!lease) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    try {
      const plan = await rejectCurrentPlan(planRootFor(session.id));
      response.json({ plan });
    } catch (error) {
      const { status, message } = planHttpError(error);
      response.status(status).json({ error: message });
    } finally {
      releaseSession(session, lease);
    }
  });

  app.post("/api/sessions/:id/plan/edit", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const planMarkdown = typeof request.body?.plan === "string" ? request.body.plan : "";
    if (!planMarkdown.trim()) {
      response.status(400).json({ error: "plan is required" });
      return;
    }
    const lease = reserveSession(session, "plan:edit");
    if (!lease) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    try {
      const plan = await editCurrentPlan(planRootFor(session.id), planMarkdown);
      response.json({ plan });
    } catch (error) {
      const { status, message } = planHttpError(error);
      response.status(status).json({ error: message });
    } finally {
      releaseSession(session, lease);
    }
  });

  app.post("/api/sessions/:id/plan/archive", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const lease = reserveSession(session, "plan:archive");
    if (!lease) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    try {
      const result = await archiveCurrentPlan(planRootFor(session.id));
      response.json({ plan: result.document, archivedPath: result.archivedPath });
    } catch (error) {
      const { status, message } = planHttpError(error);
      response.status(status).json({ error: message });
    } finally {
      releaseSession(session, lease);
    }
  });

  app.get("/api/sessions/:id/plan/history", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const plans = await listPlanHistory(planRootFor(session.id));
    response.json({ plans });
  });
}
