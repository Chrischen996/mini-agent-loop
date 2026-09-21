import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  approveCurrentPlan,
  archiveCurrentPlan,
  createAndSavePlan,
  editCurrentPlan,
  listPlanHistory,
  loadPlanDocument,
  markPlanExecutionResult,
  preparePlanForExecution,
  rejectCurrentPlan,
} from "../src/plan/index.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "plan-workflow-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("plan workflow", () => {
  it("creates a plan in pending status", async () => {
    await withTempDir(async (dir) => {
      const doc = await createAndSavePlan(dir, "task", "1. Read\n2. Edit");
      assert.equal(doc.status, "pending");
      assert.equal(doc.version, 2);
      assert.ok(doc.id.length > 0);

      const loaded = await loadPlanDocument(dir);
      assert.ok(loaded);
      assert.equal(loaded!.status, "pending");
      assert.equal(loaded!.prompt, "task");
    });
  });

  it("approves a pending plan", async () => {
    await withTempDir(async (dir) => {
      await createAndSavePlan(dir, "task", "1. Do it");
      const approved = await approveCurrentPlan(dir, "user");
      assert.equal(approved.status, "approved");
      assert.equal(approved.approvedBy, "user");
    });
  });

  it("prepare for execution sets executing and does NOT delete", async () => {
    await withTempDir(async (dir) => {
      await createAndSavePlan(dir, "task", "1. Do it", { autoApprove: true, approvedBy: "user" });
      const { document, executionPromptSuffix } = await preparePlanForExecution(dir);
      assert.equal(document.status, "executing");
      assert.ok(document.execution?.startedAt);
      assert.match(executionPromptSuffix, /Do not deviate/);

      const stillThere = await loadPlanDocument(dir);
      assert.ok(stillThere);
      assert.equal(stillThere!.status, "executing");
    });
  });

  it("mark failed keeps plan loadable with failed status", async () => {
    await withTempDir(async (dir) => {
      await createAndSavePlan(dir, "task", "1. Do it", { autoApprove: true });
      await preparePlanForExecution(dir);
      await markPlanExecutionResult(dir, { ok: false, error: "boom" });

      const loaded = await loadPlanDocument(dir);
      assert.ok(loaded);
      assert.equal(loaded!.status, "failed");
      assert.equal(loaded!.execution?.error, "boom");
      assert.ok(loaded!.execution?.finishedAt);
    });
  });

  it("prepare with yes auto-approves pending", async () => {
    await withTempDir(async (dir) => {
      await createAndSavePlan(dir, "task", "1. Do it");
      const { document } = await preparePlanForExecution(dir, { yes: true });
      assert.equal(document.status, "executing");
      assert.equal(document.approvedBy, "auto");
    });
  });

  it("edit resets to pending", async () => {
    await withTempDir(async (dir) => {
      await createAndSavePlan(dir, "task", "1. Old", { autoApprove: true, approvedBy: "user" });
      const edited = await editCurrentPlan(dir, "1. New step");
      assert.equal(edited.status, "pending");
      assert.equal(edited.approvedBy, undefined);
      assert.equal(edited.rawMarkdown, "1. New step");
    });
  });

  it("retry after failed works", async () => {
    await withTempDir(async (dir) => {
      await createAndSavePlan(dir, "task", "1. Do it", { autoApprove: true });
      await preparePlanForExecution(dir);
      await markPlanExecutionResult(dir, { ok: false, error: "failed once" });

      const failed = await loadPlanDocument(dir);
      assert.equal(failed!.status, "failed");

      const { document } = await preparePlanForExecution(dir);
      assert.equal(document.status, "executing");
      assert.ok(document.execution?.startedAt);
      assert.equal(document.execution?.finishedAt, undefined);
    });
  });

  it("rejects cannot execute without force", async () => {
    await withTempDir(async (dir) => {
      await createAndSavePlan(dir, "task", "1. Do it");
      await rejectCurrentPlan(dir);
      await assert.rejects(
        () => preparePlanForExecution(dir),
        /rejected/,
      );
    });
  });

  it("archiveCurrentPlan writes history loadable via listPlanHistory", async () => {
    await withTempDir(async (dir) => {
      const created = await createAndSavePlan(dir, "archive me", "1. Step A\n2. Step B");
      const { archivedPath, document } = await archiveCurrentPlan(dir);
      assert.ok(archivedPath.includes(document.id));
      assert.equal(document.id, created.id);

      // current plan remains
      const current = await loadPlanDocument(dir);
      assert.ok(current);
      assert.equal(current!.id, created.id);

      const history = await listPlanHistory(dir);
      assert.equal(history.length, 1);
      assert.equal(history[0]!.id, created.id);
      assert.equal(history[0]!.prompt, "archive me");
    });
  });

  it("archiveCurrentPlan can clear current when requested", async () => {
    await withTempDir(async (dir) => {
      await createAndSavePlan(dir, "clear me", "1. Step");
      await archiveCurrentPlan(dir, { clearCurrent: true });
      const current = await loadPlanDocument(dir);
      assert.equal(current, null);
      const history = await listPlanHistory(dir);
      assert.equal(history.length, 1);
    });
  });

  it("markPlanExecutionResult(ok) creates a history entry", async () => {
    await withTempDir(async (dir) => {
      await createAndSavePlan(dir, "task", "1. Do it", { autoApprove: true });
      await preparePlanForExecution(dir);
      const completed = await markPlanExecutionResult(dir, {
        ok: true,
        summary: "all good",
      });
      assert.equal(completed.status, "completed");

      // current remains completed
      const current = await loadPlanDocument(dir);
      assert.ok(current);
      assert.equal(current!.status, "completed");

      const history = await listPlanHistory(dir);
      assert.equal(history.length, 1);
      assert.equal(history[0]!.id, completed.id);
      assert.equal(history[0]!.status, "completed");
    });
  });

  it("markPlanExecutionResult(failed) does not archive", async () => {
    await withTempDir(async (dir) => {
      await createAndSavePlan(dir, "task", "1. Do it", { autoApprove: true });
      await preparePlanForExecution(dir);
      await markPlanExecutionResult(dir, { ok: false, error: "nope" });
      const history = await listPlanHistory(dir);
      assert.equal(history.length, 0);
    });
  });

  it("createPlanDocument defaults step status to todo", async () => {
    await withTempDir(async (dir) => {
      const doc = await createAndSavePlan(
        dir,
        "task",
        "1. Edit src/foo.ts\n2. Review changes",
      );
      assert.ok(doc.steps && doc.steps.length >= 1);
      assert.ok(doc.steps!.every((s) => s.status === "todo"));
    });
  });

  it("prepare stores baseline and mark ok infers step statuses", async () => {
    await withTempDir(async (dir) => {
      await createAndSavePlan(
        dir,
        "task",
        "1. Edit src/foo.ts\n2. Summarize results",
        { autoApprove: true },
      );
      const prepared = await preparePlanForExecution(dir, {
        workspaceRoot: dir,
      });
      assert.equal(prepared.document.status, "executing");
      assert.ok(prepared.document.execution?.baseline);
      assert.ok(prepared.document.steps?.some((s) => s.status === "doing"));

      const completed = await markPlanExecutionResult(dir, {
        ok: true,
        summary: "done",
        workspaceRoot: dir,
      });
      assert.equal(completed.status, "completed");
      assert.ok(completed.execution?.auditReport);
      assert.match(String(completed.execution?.auditReport), /Plan File Audit/);
      // No git changes in empty temp dir; file-bearing step may stay todo,
      // no-file step becomes done when ok.
      const summaryStep = completed.steps?.find((s) =>
        /summarize/i.test(s.text),
      );
      if (summaryStep) {
        assert.equal(summaryStep.status, "done");
      }
    });
  });
});
