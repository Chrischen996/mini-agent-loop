/**
 * Plan-Act workflow routes: session phase transitions and the in-memory
 * `planManager` plan lifecycle (`/api/sessions/:id/phase`, `/api/sessions/:id/plans`).
 */

import type { Express } from "express";
import { planManager } from "../../plan-act/plan-manager.ts";
import { planGenerator } from "../../plan-act/plan-generator.ts";
import { validatePhaseTransition } from "../../plan-act/state-machine.ts";
import type { ExecutionPlan, SessionPhase } from "../../plan-act/types.ts";
import type { SessionExecutionLease } from "../../orchestration/session-gate.ts";

/** Minimal session shape the Plan-Act routes rely on. */
export type PlanActRoutesSession = {
  id: string;
  phase?: SessionPhase;
  currentPlan?: ExecutionPlan;
  planHistory?: ExecutionPlan[];
};

export type PlanActRoutesContext<TSession extends PlanActRoutesSession> = {
  getSession: (id: string) => TSession | undefined;
  reserveSession: (session: TSession, owner: string) => SessionExecutionLease | undefined;
  releaseSession: (session: TSession, lease: SessionExecutionLease) => void;
  saveSession: (session: TSession) => Promise<void>;
};

export function registerPlanActRoutes<TSession extends PlanActRoutesSession>(
  app: Express,
  context: PlanActRoutesContext<TSession>,
): void {
  const { reserveSession, releaseSession, saveSession } = context;
  const sessions = { get: context.getSession };

  /** GET /api/sessions/:id/phase - Get current phase */
  app.get("/api/sessions/:id/phase", (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    response.json({ phase: session.phase });
  });

  /** PUT /api/sessions/:id/phase - Transition phase */
  app.put("/api/sessions/:id/phase", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const targetPhase = request.body?.phase as SessionPhase | undefined;
    if (!targetPhase) {
      response.status(400).json({ error: "phase is required" });
      return;
    }
    const result = validatePhaseTransition(session.phase ?? "planning", targetPhase, request.body);
    if (!result.allowed) {
      response.status(400).json({ error: result.reason });
      return;
    }
    const lease = reserveSession(session, "phase");
    if (!lease) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    try {
      const previousPhase = session.phase;
      session.phase = targetPhase;
      await saveSession(session);
      response.json({ from: previousPhase, to: targetPhase, reason: result.reason });
    } finally {
      releaseSession(session, lease);
    }
  });

  /** POST /api/sessions/:id/plans - Generate new plan */
  app.post("/api/sessions/:id/plans", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const output = request.body?.output as string | undefined;
    const summary = request.body?.summary as string | undefined;
    if (!output) {
      response.status(400).json({ error: "output is required" });
      return;
    }
    const lease = reserveSession(session, "plan-act:generate");
    if (!lease) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    try {
      const plan = planGenerator.generateAndStore(output, session.id, summary);
      if (!plan) {
        response.status(400).json({ error: "Failed to parse plan from output" });
        return;
      }
      session.currentPlan = plan;
      session.planHistory = session.planHistory ?? []; session.planHistory.push(plan);
      session.phase = "review";
      await saveSession(session);
      response.status(201).json(plan);
    } finally {
      releaseSession(session, lease);
    }
  });

  /** GET /api/sessions/:id/plans - List plans for session */
  app.get("/api/sessions/:id/plans", (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const plans = planManager.getSessionPlans(session.id);
    response.json(plans);
  });

  /** GET /api/sessions/:id/plans/:planId - Get plan details */
  app.get("/api/sessions/:id/plans/:planId", (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const plan = planManager.getPlan(request.params.planId);
    if (!plan) {
      response.status(404).json({ error: "Plan not found" });
      return;
    }
    if (plan.sessionId !== session.id) {
      response.status(403).json({ error: "Plan does not belong to this session" });
      return;
    }
    response.json(plan);
  });

  /** POST /api/sessions/:id/plans/:planId/approve - Approve plan */
  app.post("/api/sessions/:id/plans/:planId/approve", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const plan = planManager.getPlan(request.params.planId);
    if (!plan) {
      response.status(404).json({ error: "Plan not found" });
      return;
    }
    if (plan.sessionId !== session.id) {
      response.status(403).json({ error: "Plan does not belong to this session" });
      return;
    }
    const lease = reserveSession(session, "plan-act:approve");
    if (!lease) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    try {
      const approved = planManager.approvePlan(plan.id, request.body);
      if (!approved) {
        response.status(400).json({ error: "Failed to approve plan" });
        return;
      }
      session.currentPlan = approved;
      session.phase = "acting";
      await saveSession(session);
      response.json(approved);
    } finally {
      releaseSession(session, lease);
    }
  });

  /** POST /api/sessions/:id/plans/:planId/reject - Reject plan */
  app.post("/api/sessions/:id/plans/:planId/reject", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const plan = planManager.getPlan(request.params.planId);
    if (!plan) {
      response.status(404).json({ error: "Plan not found" });
      return;
    }
    if (plan.sessionId !== session.id) {
      response.status(403).json({ error: "Plan does not belong to this session" });
      return;
    }
    const reason = request.body?.reason as string | undefined;
    const lease = reserveSession(session, "plan-act:reject");
    if (!lease) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    try {
      const rejected = planManager.rejectPlan(plan.id, reason);
      if (!rejected) {
        response.status(400).json({ error: "Failed to reject plan" });
        return;
      }
      session.currentPlan = undefined;
      session.phase = "cancelled";
      await saveSession(session);
      response.json(rejected);
    } finally {
      releaseSession(session, lease);
    }
  });

  /** POST /api/sessions/:id/plans/:planId/modify - Request modifications */
  app.post("/api/sessions/:id/plans/:planId/modify", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const plan = planManager.getPlan(request.params.planId);
    if (!plan) {
      response.status(404).json({ error: "Plan not found" });
      return;
    }
    if (plan.sessionId !== session.id) {
      response.status(403).json({ error: "Plan does not belong to this session" });
      return;
    }
    const lease = reserveSession(session, "plan-act:modify");
    if (!lease) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    try {
      const modified = planManager.updatePlanStatus(plan.id, "modified");
      if (!modified) {
        response.status(400).json({ error: "Failed to modify plan" });
        return;
      }
      session.currentPlan = modified;
      session.phase = "planning";
      await saveSession(session);
      response.json(modified);
    } finally {
      releaseSession(session, lease);
    }
  });

  /** DELETE /api/sessions/:id/plans/:planId - Delete plan */
  app.delete("/api/sessions/:id/plans/:planId", (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const plan = planManager.getPlan(request.params.planId);
    if (!plan) {
      response.status(404).json({ error: "Plan not found" });
      return;
    }
    if (plan.sessionId !== session.id) {
      response.status(403).json({ error: "Plan does not belong to this session" });
      return;
    }
    const lease = reserveSession(session, "plan-act:delete");
    if (!lease) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    try {
      planManager.deletePlan(plan.id);
      if (session.currentPlan?.id === plan.id) {
        session.currentPlan = undefined;
      }
      response.status(204).end();
    } finally {
      releaseSession(session, lease);
    }
  });
}
