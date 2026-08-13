import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runValidation } from "../src/validation.ts";

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
