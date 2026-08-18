/**
 * Tests for subagent delegation improvements:
 * 1. Execution summary is included in subagent result
 * 2. System prompt contains clear delegation guidelines
 * 3. Auto-preflight scoring covers new patterns
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCoordinatorPromptFragment,
  buildPreflightTask,
  decideAutoSubagent,
} from "../src/subagent/auto.ts";
import { defaultProfiles, researcherProfile, coderProfile, reviewerProfile } from "../src/subagent/profiles.ts";
import { buildSystemPrompt } from "../src/loop.ts";

describe("subagent delegation improvements", () => {
  describe("auto-preflight decision triggers", () => {
    it("scores high for multi-step code tasks", () => {
      const text = "请帮我分析这个项目的代码结构，然后创建一个新组件，最后运行测试";
      const decision = decideAutoSubagent(text);
      assert.ok(decision.shouldDelegate, "should delegate multi-step code task");
      assert.ok(decision.coordinatorMode, "should enter coordinator mode");
      assert.ok(decision.score >= 2, `score ${decision.score} should be >= 2`);
      assert.equal(decision.profile, "coder");
    });

    it("scores high for investigation/review tasks", () => {
      // Must hit enough patterns to reach minScore=2: investigation + code + multi-step
      const text = "请帮我分析这个项目的主模块，然后排查潜在的 bugs 并给出改进建议";
      const decision = decideAutoSubagent(text);
      assert.ok(decision.shouldDelegate, `should delegate investigation task, got score=${decision.score} reasons=${JSON.stringify(decision.reasons)}`);
      assert.equal(decision.profile, "researcher");
    });

    it("picks reviewer for pure review requests", () => {
      const text = "请对这个项目的主模块做代码审查，检查潜在问题并给出建议";
      const decision = decideAutoSubagent(text);
      assert.ok(decision.shouldDelegate, `score=${decision.score} reasons=${JSON.stringify(decision.reasons)}`);
      assert.equal(decision.profile, "reviewer");
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

  describe("system prompt encourages orchestration", () => {
    it("mentions orchestrator preference and subagent tools", () => {
      const prompt = buildSystemPrompt("bypass");
      assert.match(prompt, /orchestrator/i);
      assert.match(prompt, /subagent_batch/);
      assert.match(prompt, /Delegate when/i);
      assert.match(prompt, /Handle directly only/i);
    });

    it("builds an active coordinator fragment with exploration budget", () => {
      const fragment = buildCoordinatorPromptFragment({
        profile: "coder",
        preflightExecuted: true,
        maxDirectExploration: 2,
      });
      assert.match(fragment, /Coordinator Mode/);
      assert.match(fragment, /coder/);
      assert.match(fragment, /At most 2 direct exploration/);
      assert.match(fragment, /subagent_batch/);
    });

    it("builds a focused preflight task for each profile", () => {
      const research = buildPreflightTask("分析这个仓库结构", "researcher");
      assert.match(research, /researcher subagent/i);
      assert.match(research, /plain-text findings summary/i);
      assert.match(research, /分析这个仓库结构/);

      const code = buildPreflightTask("实现一个新模块", "coder");
      assert.match(code, /coder subagent/i);
      assert.match(code, /files changed/i);

      const review = buildPreflightTask("审查主模块", "reviewer");
      assert.match(review, /reviewer subagent/i);
      assert.match(review, /review summary/i);
    });
  });

  describe("profiles are well-configured", () => {
    it("has exactly 3 built-in profiles", () => {
      assert.equal(defaultProfiles.length, 3);
    });

    it("researcher profile has correct tools and a higher turn budget", () => {
      const tools = researcherProfile.allowedTools ?? [];
      assert.ok(tools.includes("read"));
      assert.ok(tools.includes("grep"));
      assert.ok(!tools.includes("write"));
      assert.ok(!tools.includes("edit"));
      assert.ok((researcherProfile.maxTurns ?? 0) >= 12);
    });

    it("coder profile has write/edit tools", () => {
      const tools = coderProfile.allowedTools ?? [];
      assert.ok(tools.includes("write"));
      assert.ok(tools.includes("edit"));
      assert.ok(tools.includes("read"));
    });

    it("reviewer profile is read-only", () => {
      const tools = reviewerProfile.allowedTools ?? [];
      assert.ok(!tools.includes("write"));
      assert.ok(!tools.includes("edit"));
    });
  });
});
