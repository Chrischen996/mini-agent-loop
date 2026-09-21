import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePlan, formatPlanPreview } from "../src/plan-formatter.ts";
import type { PlanSummary } from "../src/plan-formatter.ts";

describe("parsePlan", () => {
  it("extracts numbered steps", () => {
    const summary = parsePlan("add auth", `
## Plan
1. Read the auth module
2. Edit src/auth.ts to add JWT
3. Run tests with npm test
    `);
    assert.equal(summary.stepCount, 3);
    assert.equal(summary.steps[0]!.text, "Read the auth module");
    assert.equal(summary.steps[1]!.text, "Edit src/auth.ts to add JWT");
    assert.equal(summary.steps[2]!.text, "Run tests with npm test");
  });

  it("extracts bullet steps", () => {
    const summary = parsePlan("task", "- Step one\n- Step two");
    assert.equal(summary.stepCount, 2);
    assert.equal(summary.steps[0]!.text, "Step one");
    assert.equal(summary.steps[1]!.text, "Step two");
  });

  it("detects file paths", () => {
    const summary = parsePlan("t", "1. Edit src/auth.ts\n2. Read config.json");
    assert.deepStrictEqual(summary.files, ["src/auth.ts", "config.json"]);
  });

  it("detects action types from keywords", () => {
    const summary = parsePlan("t", "1. grep for patterns in src/\n2. write new file\n3. run npm test");
    assert.ok(summary.actions.includes("read"), "should detect read action");
    assert.ok(summary.actions.includes("write"), "should detect write action");
    assert.ok(summary.actions.includes("bash"), "should detect bash action");
  });

  it("stores raw plan text", () => {
    const raw = "1. Do A\n2. Do B";
    const summary = parsePlan("prompt", raw);
    assert.equal(summary.raw, raw);
  });

  it("handles empty plan", () => {
    const summary = parsePlan("t", "");
    assert.equal(summary.stepCount, 0);
    assert.equal(summary.steps.length, 0);
  });
});

describe("formatPlanPreview", () => {
  it("produces readable output with steps", () => {
    const summary: PlanSummary = {
      prompt: "add login",
      stepCount: 2,
      steps: [
        { index: 1, text: "Read src/auth.ts", files: ["src/auth.ts"], tool: "read" },
        { index: 2, text: "Edit auth module", files: ["src/auth.ts"], tool: "edit" },
      ],
      files: ["src/auth.ts"],
      actions: ["read", "edit"],
      raw: "1. Read src/auth.ts\n2. Edit auth module",
    };
    const output = formatPlanPreview(summary);
    assert.ok(output.includes("add login"));
    assert.ok(output.includes("Steps"));
    assert.ok(output.includes("1."));
    assert.ok(output.includes("2."));
    assert.ok(output.includes("src/auth.ts"));
  });

  it("includes action labels", () => {
    const summary: PlanSummary = {
      prompt: "task",
      stepCount: 1,
      steps: [{ index: 1, text: "run tests", files: [], tool: "bash" }],
      files: [],
      actions: ["bash"],
      raw: "run tests",
    };
    const output = formatPlanPreview(summary);
    assert.ok(output.includes("⚡"));
  });
});
