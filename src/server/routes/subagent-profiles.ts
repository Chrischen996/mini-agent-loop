/**
 * `/api/subagent/profiles` — hot-updatable subagent profile registry.
 */

import type { Express } from "express";
import type { SubagentProfile } from "../../subagent/index.ts";

export type SubagentProfileRoutesContext = {
  /** Reads the currently active profile list (server default or override). */
  getProfiles: () => SubagentProfile[];
  /** Publishes an updated list so new sessions pick up the change. */
  setProfiles: (profiles: SubagentProfile[]) => void;
};

function summarize(profile: SubagentProfile): Record<string, unknown> {
  return {
    name: profile.name,
    description: profile.description,
    allowedTools: profile.allowedTools,
    maxTurns: profile.maxTurns,
    timeout: profile.timeout,
    hasCustomLlm: Boolean(profile.llm),
  };
}

export function registerSubagentProfileRoutes(
  app: Express,
  context: SubagentProfileRoutesContext,
): void {
  const { getProfiles, setProfiles } = context;

  app.get("/api/subagent/profiles", (_request, response) => {
    response.json({ profiles: getProfiles().map(summarize) });
  });

  app.put("/api/subagent/profiles/:name", (request, response) => {
    const name = request.params.name;
    const body = request.body as Partial<SubagentProfile> | undefined;
    if (!body || typeof body.description !== "string" || typeof body.systemPrompt !== "string") {
      response.status(400).json({ error: "description and systemPrompt are required" });
      return;
    }
    const profiles = getProfiles();
    const existing = profiles.findIndex((profile) => profile.name === name);
    const newProfile: SubagentProfile = {
      name,
      description: body.description,
      systemPrompt: body.systemPrompt,
      allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools : undefined,
      maxTurns: typeof body.maxTurns === "number" ? body.maxTurns : undefined,
      timeout: typeof body.timeout === "number" ? body.timeout : undefined,
    };
    if (existing >= 0) profiles[existing] = newProfile;
    else profiles.push(newProfile);
    setProfiles(profiles);
    response.json({
      name: newProfile.name,
      description: newProfile.description,
      allowedTools: newProfile.allowedTools,
      maxTurns: newProfile.maxTurns,
    });
  });

  app.delete("/api/subagent/profiles/:name", (request, response) => {
    const name = request.params.name;
    const profiles = getProfiles();
    const index = profiles.findIndex((profile) => profile.name === name);
    if (index < 0) {
      response.status(404).json({ error: `Profile "${name}" not found` });
      return;
    }
    profiles.splice(index, 1);
    setProfiles(profiles);
    response.status(204).end();
  });
}
