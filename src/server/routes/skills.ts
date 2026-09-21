/**
 * `/api/sessions/:id/skills` — inspect and update the skills activated for a
 * session.
 */

import type { Express } from "express";
import { activateSkillNames, uniqueSkillNames } from "../../skills/index.ts";
import type { SkillRegistry } from "../../skills/types.ts";
import type { SessionExecutionLease } from "../../orchestration/session-gate.ts";

/** Minimal session shape the skill routes rely on. */
export type SkillRoutesSession = {
  id: string;
  skillNames?: string[];
};

export type SkillRoutesContext<TSession extends SkillRoutesSession> = {
  getSession: (id: string) => TSession | undefined;
  reserveSession: (session: TSession, owner: string) => SessionExecutionLease | undefined;
  releaseSession: (session: TSession, lease: SessionExecutionLease) => void;
  saveSession: (session: TSession) => Promise<void>;
  skillRegistry: SkillRegistry;
};

export function registerSkillRoutes<TSession extends SkillRoutesSession>(
  app: Express,
  context: SkillRoutesContext<TSession>,
): void {
  const { reserveSession, releaseSession, saveSession, skillRegistry } = context;
  const sessions = { get: context.getSession };

  app.get("/api/sessions/:id/skills", (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const activation = activateSkillNames(session.skillNames ?? [], skillRegistry);
    response.json({
      available: activation.available.map((skill) => ({
        name: skill.name,
        description: skill.description,
      })),
      active: activation.activeNames,
      missing: activation.missingNames,
    });
  });

  app.put("/api/sessions/:id/skills", async (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const body = (request.body ?? {}) as {
      skillNames?: unknown;
      add?: unknown;
      remove?: unknown;
    };
    const requested = Array.isArray(body.skillNames)
      ? body.skillNames.filter((name): name is string => typeof name === "string")
      : (session.skillNames ?? []);
    const add = Array.isArray(body.add)
      ? body.add.filter((name): name is string => typeof name === "string")
      : [];
    const remove = new Set(
      Array.isArray(body.remove)
        ? body.remove.filter((name): name is string => typeof name === "string")
        : [],
    );
    const merged = uniqueSkillNames([...requested, ...add]).filter((name) => !remove.has(name));
    const lease = reserveSession(session, "skills");
    if (!lease) {
      response.status(409).json({ error: "Session is busy" });
      return;
    }
    const activation = activateSkillNames(merged, skillRegistry);
    try {
      session.skillNames = activation.activeNames;
      await saveSession(session);
      response.json({
        available: activation.available.map((skill) => ({
          name: skill.name,
          description: skill.description,
        })),
        active: activation.activeNames,
        missing: activation.missingNames,
      });
    } finally {
      releaseSession(session, lease);
    }
  });
}
