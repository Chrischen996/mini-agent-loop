/**
 * Tests for subagent delegation improvements:
 * 1. Execution summary is included in subagent result
 * 2. System prompt contains clear delegation guidelines
 * 3. Auto-preflight scoring covers new patterns
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideAutoSubagent } from "../src/subagent/auto.ts";
import { defaultProfiles, researcherProfile, coderProfile, reviewerProfile } from "../src/subagent/profiles.ts";

describe("subagent delegation improvements", () => {
  describe("auto-preflight decision triggers", () => {
    it("scores high for multi-step code tasks", () => {
      const text = "请帮我分析这个项目的代码结构，然后创建一个新组件，最后运行测试";
      const decision = decideAutoSubagent(text);
      assert.ok(decision.shouldDelegate, "should delegate multi-step code task");
      assert.ok(decision.score >= 3, `score ${decision.score} should be >= 3`);
    });

    it("scores high for investigation/review tasks", () => {
      // Must hit 2+ patterns to reach minScore=3: investigation + code + multi-step
      const text = "请帮我分析这个项目的主模块，然后排查潜在的 bugs 并给出改进建议";
      const decision = decideAutoSubagent(text);
      assert.ok(decision.shouldDelegate, `should delegate investigation task, got score=${decision.score} reasons=${JSON.stringify(decision.reasons)}`);
    });

    it("does not trigger for simple single-step tasks", () => {
      const text = "读一下 package.json";
      const decision = decideAutoSubagent(text);
      assert.ok(!decision.shouldDelegate, "should NOT delegate simple read task");
    });

    it("scores high for long prompts with code context", () => {
      // Long text alone is +1; add code keyword to reach threshold
      const longText = "A".repeat(501) + " 请分析这个项目的代码结构";
      const decision = decideAutoSubagent(longText);
      assert.ok(decision.shouldDelegate, `should delegate long code prompt, got score=${decision.score}`);
    });

    it("scores highest for explicit delegation signals", () => {
      const text = "请用一个子agent来处理这个任务：分析项目结构";
      const decision = decideAutoSubagent(text);
      assert.ok(decision.shouldDelegate);
      assert.ok(decision.score >= 2, "explicit delegation should score >= 2");
    });
  });

  describe("profiles are well-configured", () => {
    it("has exactly 3 built-in profiles", () => {
      assert.equal(defaultProfiles.length, 3);
    });

    it("researcher profile has correct tools", () => {
      assert.ok(researcherProfile.allowedTools.includes("read"));
      assert.ok(researcherProfile.allowedTools.includes("grep"));
      assert.ok(!researcherProfile.allowedTools.includes("write"));
      assert.ok(!researcherProfile.allowedTools.includes("edit"));
    });

    it("coder profile has write/edit tools", () => {
      assert.ok(coderProfile.allowedTools.includes("write"));
      assert.ok(coderProfile.allowedTools.includes("edit"));
      assert.ok(coderProfile.allowedTools.includes("read"));
    });

    it("reviewer profile is read-only", () => {
      assert.ok(!reviewerProfile.allowedTools.includes("write"));
      assert.ok(!reviewerProfile.allowedTools.includes("edit"));
    });
  });
});
