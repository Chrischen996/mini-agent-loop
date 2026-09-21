/**
 * `/api/git/*` and `/api/validation` — workspace VCS operations and the
 * test/typecheck/build validation runner.
 */

import type { Express } from "express";
import type { GitWorkflow } from "../../git/workflow.ts";
import { formatValidationReport, runValidation, type ValidationStepName } from "../../validation.ts";
import { errorMessage, respondOrFail } from "./types.ts";

const VALIDATION_STEPS: readonly ValidationStepName[] = ["test", "typecheck", "build"];

function isValidationStep(value: unknown): value is ValidationStepName {
  return typeof value === "string" && (VALIDATION_STEPS as readonly string[]).includes(value);
}

export type GitRoutesContext = {
  gitWorkflow: GitWorkflow;
  workspace: string;
};

export function registerGitRoutes(app: Express, context: GitRoutesContext): void {
  const { gitWorkflow, workspace } = context;

  app.get("/api/git/status", async (_request, response) => {
    await respondOrFail(response, 400, async () => { response.json(await gitWorkflow.status()); });
  });

  app.get("/api/git/diff", async (request, response) => {
    await respondOrFail(response, 400, async () => {
      const diff = await gitWorkflow.diff({
        staged: String(request.query.staged ?? "") === "true",
        path: request.query.path ? String(request.query.path) : undefined,
      });
      response.type("text/plain").send(diff);
    });
  });

  app.get("/api/git/checkpoints", async (_request, response) => {
    await respondOrFail(response, 400, async () => {
      response.json({ checkpoints: await gitWorkflow.listCheckpoints() });
    });
  });

  app.post("/api/git/checkpoints", async (request, response) => {
    await respondOrFail(response, 400, async () => {
      const checkpoint = await gitWorkflow.createCheckpoint(String(request.body?.label ?? "agent-change"));
      response.status(201).json(checkpoint);
    });
  });

  app.post("/api/git/undo", async (request, response) => {
    const checkpointId = String(request.body?.checkpointId ?? "");
    if (!checkpointId) {
      response.status(400).json({ error: "checkpointId is required" });
      return;
    }
    await respondOrFail(response, 400, async () => { response.json(await gitWorkflow.undo(checkpointId)); });
  });

  app.post("/api/git/branches", async (request, response) => {
    await respondOrFail(response, 400, async () => {
      response.status(201).json(await gitWorkflow.createIsolatedBranch(String(request.body?.label ?? "task")));
    });
  });

  app.post("/api/validation", async (request, response) => {
    const requested = Array.isArray(request.body?.steps) ? request.body.steps : undefined;
    const steps = requested?.filter(isValidationStep);
    try {
      const report = await runValidation({
        workspace,
        steps,
        timeoutMs: typeof request.body?.timeoutMs === "number" ? request.body.timeoutMs : undefined,
      });
      response.status(report.ok ? 200 : 422).json({ ...report, summary: formatValidationReport(report) });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
}
