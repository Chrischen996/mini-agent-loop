import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  auditPlanFiles,
  formatAuditReport,
  inferStepStatuses,
  normalizePath,
  pathsMatch,
} from "../src/plan/audit.ts";

describe("plan audit helpers", () => {
  it("auditPlanFiles reports missing planned and unplanned files", () => {
    const result = auditPlanFiles(["a.ts", "b.ts"], ["a.ts", "c.ts"]);
    assert.deepEqual(result.changedFiles, ["a.ts", "c.ts"]);
    assert.deepEqual(result.missingPlannedFiles, ["b.ts"]);
    assert.deepEqual(result.unplannedFiles, ["c.ts"]);
    assert.match(result.report, /Plan File Audit/);
    assert.match(result.report, /Missing planned/);
    assert.match(result.report, /Unplanned/);
  });

  it("pathsMatch supports basename and suffix forms", () => {
    assert.equal(pathsMatch("src/foo.ts", "src/foo.ts"), true);
    assert.equal(pathsMatch("./src/foo.ts", "src/foo.ts"), true);
    assert.equal(pathsMatch("src/foo.ts", "foo.ts"), true);
    assert.equal(pathsMatch("src/foo.ts", "bar.ts"), false);
  });

  it("normalizePath strips ./ and backslashes", () => {
    assert.equal(normalizePath(".\\src\\a.ts"), "src/a.ts");
    assert.equal(normalizePath("./src/a.ts"), "src/a.ts");
  });

  it("inferStepStatuses marks steps done when their files changed", () => {
    const updates = inferStepStatuses(
      [
        { index: 1, text: "edit a", files: ["a.ts"], status: "todo" },
        { index: 2, text: "edit b", files: ["b.ts"], status: "todo" },
      ],
      ["a.ts"],
      true,
    );
    assert.equal(updates.find((u) => u.index === 1)?.status, "done");
    assert.equal(updates.find((u) => u.index === 2)?.status, "todo");
  });

  it("inferStepStatuses marks all no-file steps done when execution ok", () => {
    const updates = inferStepStatuses(
      [
        { index: 1, text: "analyze", status: "todo" },
        { index: 2, text: "summarize", status: "todo" },
      ],
      [],
      true,
    );
    assert.ok(updates.every((u) => u.status === "done"));
  });

  it("inferStepStatuses marks a step failed when execution fails with no hits", () => {
    const updates = inferStepStatuses(
      [
        { index: 1, text: "edit a", files: ["a.ts"], status: "todo" },
        { index: 2, text: "edit b", files: ["b.ts"], status: "todo" },
      ],
      [],
      false,
    );
    assert.ok(updates.some((u) => u.status === "failed"));
  });

  it("formatAuditReport includes step section", () => {
    const report = formatAuditReport({
      plannedFiles: ["a.ts"],
      changedFiles: ["a.ts"],
      missingPlannedFiles: [],
      unplannedFiles: [],
      stepUpdates: [{ index: 1, status: "done", reason: "touched a.ts" }],
    });
    assert.match(report, /Plan File Audit/);
    assert.match(report, /Steps:/);
    assert.match(report, /1\. done/);
  });

  it("excludes files that were already dirty at the execution baseline", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const root = await mkdtemp(`${tmpdir()}/mini-agent-plan-audit-`);
    try {
      await exec("git", ["init", "-q"], { cwd: root });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
      await exec("git", ["config", "user.name", "test"], { cwd: root });
      await writeFile(`${root}/baseline.ts`, "before\n", "utf8");
      await exec("git", ["add", "."], { cwd: root });
      await exec("git", ["commit", "-qm", "baseline"], { cwd: root });
      await writeFile(`${root}/baseline.ts`, "preexisting\n", "utf8");
      await writeFile(`${root}/new.ts`, "new\n", "utf8");
      const { captureBaseline, collectChangedFiles } = await import("../src/plan/audit.ts");
      const changed = await collectChangedFiles(root, { dirtyFiles: ["baseline.ts"] });
      assert.deepEqual(changed, ["new.ts"]);
      await rm(`${root}/new.ts`, { force: true });
      const baseline = await captureBaseline(root);
      await writeFile(`${root}/baseline.ts`, "changed during execution\n", "utf8");
      await writeFile(`${root}/new.ts`, "new during execution\n", "utf8");
      const changedWithHash = await collectChangedFiles(root, baseline);
      assert.deepEqual(changedWithHash, ["baseline.ts", "new.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
