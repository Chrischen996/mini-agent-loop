import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideAutoSubagent } from "../src/subagent/auto.ts";

describe("decideAutoSubagent", () => {
  it("delegates on simple code tasks with lowered threshold", () => {
    // "implement a feature" used to score 1 (CODE_PATTERN), below old threshold of 3
    // Now with minScore=2, it should delegate
    const result = decideAutoSubagent("Implement a new login feature with JWT");
    assert.equal(result.shouldDelegate, true);
    assert.ok(result.score >= 2, `expected score >= 2, got ${result.score}`);
  });

  it("delegates on multi-step tasks", () => {
    // Needs both multi-step AND code keywords to hit minScore=2
    const result = decideAutoSubagent("First read src/auth.ts, then write src/token.ts");
    assert.equal(result.shouldDelegate, true);
  });

  it("delegates on investigation tasks", () => {
    const result = decideAutoSubagent("Analyze the auth module and summarize the API");
    assert.equal(result.shouldDelegate, true);
  });

  it("does not delegate on simple one-liners", () => {
    const result = decideAutoSubagent("What is 2+2?");
    assert.equal(result.shouldDelegate, false);
  });

  it("does not delegate on single file reads", () => {
    const result = decideAutoSubagent("Read package.json");
    assert.equal(result.shouldDelegate, false);
  });

  it("always delegates on explicit delegation signals", () => {
    const result = decideAutoSubagent("delegate this to a subagent");
    assert.equal(result.shouldDelegate, true);
    assert.ok(result.reasons.includes("explicit delegation signal"));
  });

  it("respects custom minScore", () => {
    const result = decideAutoSubagent("Read a file", { minScore: 5 });
    assert.equal(result.shouldDelegate, false);
  });

  it("returns profile recommendation", () => {
    const result = decideAutoSubagent("Implement a new API endpoint");
    assert.equal(result.profile, "researcher");
  });

  it("uses custom profile when provided", () => {
    const result = decideAutoSubagent("implement feature", { profile: "coder", allowWrites: true });
    assert.equal(result.profile, "coder");
  });

  it("scores complex parallel tasks highly", () => {
    const result = decideAutoSubagent("Check these 5 files and summarize each in parallel");
    assert.equal(result.shouldDelegate, true);
    assert.ok(result.score >= 3, `expected score >= 3, got ${result.score}`);
  });
});
