/**
 * `/api/git/*` and `/api/validation` — workspace VCS operations and the
 * test/typecheck/build validation runner.
 */

import type { Express, Request } from "express";
import type { GitWorkflow } from "../../git/workflow.ts";
import type { WorkspaceRecord } from "../../workspaces.ts";
import { formatValidationReport, runValidation, type ValidationStepName } from "../../validation.ts";
import { errorMessage, respondOrFail } from "./types.ts";

const VALIDATION_STEPS: readonly ValidationStepName[] = ["test", "typecheck", "build"];

function isValidationStep(value: unknown): value is ValidationStepName {
  return typeof value === "string" && (VALIDATION_STEPS as readonly string[]).includes(value);
}

export type GitRoutesContext = {
  workspace: string;
  getWorkspace: (id: string | undefined) => WorkspaceRecord | undefined;
  getGitWorkflow: (id: string | undefined) => GitWorkflow;
};

export function registerGitRoutes(app: Express, context: GitRoutesContext): void {
  const { workspace } = context;
  app.use(["/api/git", "/api/validation"], (request, response, next) => {
    const workspaceId = typeof request.query.workspaceId === "string"
      ? request.query.workspaceId
      : typeof request.body?.workspaceId === "string" ? request.body.workspaceId : undefined;
    if (workspaceId && !context.getWorkspace(workspaceId)) {
      response.status(404).json({ error: "Workspace not found" });
      return;
    }
    next();
  });
  const selected = (request: Request) => {
    const workspaceId = typeof request.query.workspaceId === "string"
      ? request.query.workspaceId
      : typeof request.body?.workspaceId === "string" ? request.body.workspaceId : undefined;
    const record = context.getWorkspace(workspaceId);
    return { workspace: record?.path ?? workspace, gitWorkflow: context.getGitWorkflow(record?.id) };
  };

  app.get("/api/git/status", async (request, response) => {
    const { gitWorkflow } = selected(request);
    await respondOrFail(response, 400, async () => { response.json(await gitWorkflow.status()); });
  });

  app.get("/api/git/diff", async (request, response) => {
    const { gitWorkflow } = selected(request);
    await respondOrFail(response, 400, async () => {
      const diff = await gitWorkflow.diff({
        staged: String(request.query.staged ?? "") === "true",
        path: request.query.path ? String(request.query.path) : undefined,
      });
      response.type("text/plain").send(diff);
    });
  });

  app.get("/api/git/checkpoints", async (request, response) => {
    const { gitWorkflow } = selected(request);
    await respondOrFail(response, 400, async () => {
      response.json({ checkpoints: await gitWorkflow.listCheckpoints() });
    });
  });

  app.post("/api/git/checkpoints", async (request, response) => {
    const { gitWorkflow } = selected(request);
    await respondOrFail(response, 400, async () => {
      const checkpoint = await gitWorkflow.createCheckpoint(String(request.body?.label ?? "agent-change"));
      response.status(201).json(checkpoint);
    });
  });

  app.post("/api/git/undo", async (request, response) => {
    const { gitWorkflow } = selected(request);
    const checkpointId = String(request.body?.checkpointId ?? "");
    if (!checkpointId) {
      response.status(400).json({ error: "checkpointId is required" });
      return;
    }
    await respondOrFail(response, 400, async () => { response.json(await gitWorkflow.undo(checkpointId)); });
  });

  app.post("/api/git/branches", async (request, response) => {
    const { gitWorkflow } = selected(request);
    await respondOrFail(response, 400, async () => {
      response.status(201).json(await gitWorkflow.createIsolatedBranch(String(request.body?.label ?? "task")));
    });
  });

  app.post("/api/validation", async (request, response) => {
    const { workspace: selectedWorkspace } = selected(request);
    const requested = Array.isArray(request.body?.steps) ? request.body.steps : undefined;
    const steps = requested?.filter(isValidationStep);
    try {
      const report = await runValidation({
        workspace: selectedWorkspace,
        steps,
        timeoutMs: typeof request.body?.timeoutMs === "number" ? request.body.timeoutMs : undefined,
      });
      response.status(report.ok ? 200 : 422).json({ ...report, summary: formatValidationReport(report) });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
}
