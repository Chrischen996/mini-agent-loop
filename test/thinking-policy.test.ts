import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeLlmConfig } from "../src/llm/index.ts";
import {
  decideInitialThinkingLevel,
  decideNextThinkingLevel,
  loadThinkingModeFromEnv,
} from "../src/thinking-policy.ts";

const reasoningLlm = makeLlmConfig({
  apiKey: "test",
  baseUrl: "http://localhost/v1",
  model: "faux",
  reasoning: true,
  thinkingLevel: "medium",
});

describe("adaptive thinking policy", () => {
  it("defaults to fixed mode and accepts an adaptive environment override", () => {
    assert.equal(loadThinkingModeFromEnv({}), "fixed");
    assert.equal(loadThinkingModeFromEnv({ MINI_AGENT_THINKING_MODE: "adaptive" }), "adaptive");
    assert.equal(loadThinkingModeFromEnv({ MINI_AGENT_THINKING_MODE: "unexpected" }), "fixed");
  });

  it("selects low effort for a read-only request", () => {
    const decision = decideInitialThinkingLevel({
      prompt: "Explain what this module does",
      llm: reasoningLlm,
    });
    assert.equal(decision.level, "low");
    assert.ok(decision.reasons.includes("read_only_request"));
  });

  it("selects deeper effort for a multi-step implementation with verification", () => {
    const decision = decideInitialThinkingLevel({
      prompt: "Implement the session workflow, update multiple files, then run test, typecheck, and build verification",
      llm: reasoningLlm,
    });
    assert.equal(decision.level, "high");
    assert.ok(decision.reasons.includes("change_request"));
    assert.ok(decision.reasons.includes("multi_step_request"));
    assert.ok(decision.reasons.includes("validation_request"));
  });

  it("escalates one supported level after validation fails", () => {
    const decision = decideNextThinkingLevel({
      llm: reasoningLlm,
      currentLevel: "low",
      toolResults: [{ name: "validate_workspace", isError: true }],
      escalationCount: 0,
    });
    assert.equal(decision?.level, "medium");
    assert.deepEqual(decision?.reasons, ["validation_failure"]);
  });

  it("stops escalating at the configured limit", () => {
    const decision = decideNextThinkingLevel({
      llm: reasoningLlm,
      currentLevel: "high",
      toolResults: [{ name: "bash", isError: true }],
      escalationCount: 1,
      maxEscalations: 1,
    });
    assert.equal(decision, undefined);
  });

  it("keeps a high-score prompt at high when xhigh is unmapped", () => {
    const decision = decideInitialThinkingLevel({
      prompt: `${"Implement the architecture and then run test verification. ".repeat(80)}`,
      llm: reasoningLlm,
      hasAttachments: true,
    });
    assert.equal(decision.level, "high");
    assert.ok(decision.score > 6);
  });

  it("selects xhigh for a high-score prompt when the model maps it", () => {
    const llm = {
      ...reasoningLlm,
      piModel: { thinkingLevelMap: { xhigh: "xhigh" } },
    } as typeof reasoningLlm;
    const decision = decideInitialThinkingLevel({
      prompt: `${"Implement the architecture and then run test verification. ".repeat(80)}`,
      llm,
      hasAttachments: true,
    });
    assert.equal(decision.level, "xhigh");
    assert.ok(decision.score > 6);
  });

  it("does not invent ultra when escalating from high on an unmapped model", () => {
    const decision = decideNextThinkingLevel({
      llm: reasoningLlm,
      currentLevel: "high",
      toolResults: [{ name: "bash", isError: true }],
      escalationCount: 0,
    });
    assert.equal(decision, undefined);
  });

  it("escalates from high to xhigh when the model maps it", () => {
    const llm = {
      ...reasoningLlm,
      piModel: { thinkingLevelMap: { xhigh: "xhigh" } },
    } as typeof reasoningLlm;
    const decision = decideNextThinkingLevel({
      llm,
      currentLevel: "high",
      toolResults: [{ name: "bash", isError: true }],
      escalationCount: 0,
    });
    assert.equal(decision?.level, "xhigh");
    assert.deepEqual(decision?.reasons, ["tool_failure"]);
  });
});
