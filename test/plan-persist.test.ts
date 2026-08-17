import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { savePlan, loadPlan, clearPlan } from "../src/plan-persist.ts";
import type { PlanFile } from "../src/plan-persist.ts";

describe("plan-persist", () => {
  it("saves and loads a plan", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "plan-test-"));
    try {
      const saved = await savePlan(dir, "my task", "## Plan\n1. Read\n2. Edit");
      assert.ok(saved.endsWith(".mini-agent-plan.json"));
      const loaded = await loadPlan(dir);
      assert.ok(loaded !== null);
      assert.equal(loaded!.prompt, "my task");
      assert.equal(loaded!.plan, "## Plan\n1. Read\n2. Edit");
      assert.equal(loaded!.version, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no plan file exists", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "plan-test-"));
    try {
      const result = await loadPlan(dir);
      assert.equal(result, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("clears the plan file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "plan-test-"));
    try {
      await savePlan(dir, "t", "p");
      await clearPlan(dir);
      const loaded = await loadPlan(dir);
      // Cleared file is empty string, which JSON.parse fails on → returns null
      assert.equal(loaded, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
