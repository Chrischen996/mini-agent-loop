import assert from "node:assert/strict";
import test from "node:test";
import { formatValidationReport, type ValidationReport } from "../src/validation.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runValidation } from "../src/validation.ts";

test("validation reports identify the workspace and failed command", () => {
  const report: ValidationReport = {
    workspace: "/workspace/project",
    ok: false,
    startedAt: 1,
    finishedAt: 2,
    steps: [{
      name: "typecheck",
      command: "npm",
      args: ["run", "typecheck", "--if-present"],
      startedAt: 1,
      finishedAt: 2,
      ok: false,
      exitCode: 2,
      output: "src/index.ts(4,1): error",
    }],
  };

  const formatted = formatValidationReport(report);
  assert.match(formatted, /Validation: FAIL/);
  assert.match(formatted, /Workspace: \/workspace\/project/);
  assert.match(formatted, /Command: npm run typecheck --if-present/);
  assert.match(formatted, /Exit code: 2/);
  assert.match(formatted, /src\/index\.ts\(4,1\): error/);
});

test("validation reports explain when no scripts are configured", () => {
  const formatted = formatValidationReport({
    workspace: "/workspace/project",
    ok: true,
    startedAt: 1,
    finishedAt: 2,
    steps: [],
  });

  assert.match(formatted, /Validation: SKIPPED/);
  assert.match(formatted, /No validation scripts configured/);
});

describe("workspace validation", () => {
  it("runs configured steps in order and stops at the first failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-validation-"));
    try {
      await writeFile(path.join(root, "package.json"), JSON.stringify({
        scripts: { test: "node -e \"console.log('test ok')\"", typecheck: "node -e \"console.error('typecheck failed'); process.exit(2)\"", build: "node -e \"console.log('build should not run')\"" },
      }), "utf8");
      const report = await runValidation({ workspace: root });
      assert.equal(report.ok, false);
      assert.deepEqual(report.steps.map((step) => step.name), ["test", "typecheck"]);
      assert.equal(report.steps[0]?.ok, true);
      assert.equal(report.steps[1]?.ok, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
