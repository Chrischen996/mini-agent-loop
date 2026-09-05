/**
 * `/api/jobs/*` and `/api/sessions/:id/jobs` — background orchestration jobs.
 *
 * The session type and its execution-lease helpers stay owned by the server
 * factory; this module only depends on the small surface it needs.
 */

import type { Express } from "express";
import type { JobManager } from "../../orchestration/index.ts";
import type { SessionExecutionLease } from "../../orchestration/session-gate.ts";
import { errorMessage } from "./types.ts";

/** Minimal session shape the job routes rely on. */
export type JobRoutesSession = {
  id: string;
  activeJobId?: string;
};

export type JobRoutesContext<TSession extends JobRoutesSession> = {
  jobManager: JobManager;
  getSession: (id: string) => TSession | undefined;
  /** Acquires the session execution lease, or `undefined` when busy. */
  reserveSession: (session: TSession, owner: string) => SessionExecutionLease | undefined;
  releaseSession: (session: TSession, lease: SessionExecutionLease) => void;
  startSessionJob: (session: TSession, jobId: string, lease: SessionExecutionLease) => Promise<void>;
};

export function registerJobRoutes<TSession extends JobRoutesSession>(
  app: Express,
  context: JobRoutesContext<TSession>,
): void {
  const { jobManager, getSession, reserveSession, releaseSession, startSessionJob } = context;

  app.get("/api/jobs/:id", (request, response) => {
    const job = jobManager.get(request.params.id);
    if (!job) {
      response.status(404).json({ error: "Job not found" });
      return;
    }
    response.json({ job });
  });

  app.get("/api/sessions/:id/jobs", (request, response) => {
    if (!getSession(request.params.id)) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    response.json({ jobs: jobManager.list(request.params.id) });
  });

  app.post("/api/sessions/:id/jobs", async (request, response) => {
    const session = getSession(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const task = typeof request.body?.prompt === "string" ? request.body.prompt.trim() : "";
    const requestedKind = request.body?.kind;
    if (
      requestedKind !== undefined
      && requestedKind !== "agent_turn"
      && requestedKind !== "planner_worker_reviewer"
    ) {
      response.status(400).json({ error: "kind must be agent_turn or planner_worker_reviewer" });
      return;
    }
    if (!task) {
      response.status(400).json({ error: "prompt is required" });
      return;
    }
    const lease = reserveSession(session, "job:create");
    if (!lease) {
      response.status(409).json({
        error: "Session already has an active job",
        jobId: session.activeJobId ?? null,
      });
      return;
    }
    try {
      const job = await jobManager.create({
        sessionId: session.id,
        task,
        kind: requestedKind ?? "agent_turn",
      });
      session.activeJobId = job.id;
      await startSessionJob(session, job.id, lease);
      response.status(202).json({ job });
    } catch (error) {
      releaseSession(session, lease);
      session.activeJobId = undefined;
      response.status(500).json({ error: errorMessage(error) });
    }
  });

  for (const action of ["pause", "resume", "cancel"] as const) {
    app.post(`/api/jobs/:id/${action}`, async (request, response) => {
      try {
        response.json({ job: await jobManager[action](request.params.id) });
      } catch (error) {
        response.status(404).json({ error: errorMessage(error) });
      }
    });
  }

  app.post("/api/jobs/:id/retry", async (request, response) => {
    const existing = jobManager.get(request.params.id);
    if (!existing) {
      response.status(404).json({ error: "Job not found" });
      return;
    }
    const session = getSession(existing.sessionId);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const lease = reserveSession(session, "job:retry");
    if (!lease) {
      response.status(409).json({
        error: "Session already has an active job",
        jobId: session.activeJobId ?? null,
      });
      return;
    }
    try {
      const job = await jobManager.retry(existing.id);
      session.activeJobId = job.id;
      await startSessionJob(session, job.id, lease);
      response.status(202).json({ job });
    } catch (error) {
      releaseSession(session, lease);
      session.activeJobId = undefined;
      const message = errorMessage(error);
      response
        .status(/Invalid orchestration job transition/i.test(message) ? 409 : 500)
        .json({ error: message });
    }
  });
}
