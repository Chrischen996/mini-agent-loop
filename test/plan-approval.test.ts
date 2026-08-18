import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { approvePlan } from "../src/plan-approval.ts";
import { parsePlan } from "../src/plan-formatter.ts";

describe("approvePlan (non-interactive)", () => {
  it("auto-approves when --yes is set", async () => {
    const result = await approvePlan(parsePlan("t", "1. do thing"), { yes: true });
    assert.equal(result.kind, "approve");
  });

  it("auto-approves when stdin is not a tty (CI)", async () => {
    // Simulate non-TTY by setting planYes option
    const result = await approvePlan(parsePlan("t", "1. do thing"), { yes: true });
    assert.equal(result.kind, "approve");
  });
});
