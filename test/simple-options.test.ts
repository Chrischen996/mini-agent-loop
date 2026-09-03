import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_THINKING_BUDGETS, adjustMaxTokensForThinking } from "../src/pi-ai/api/simple-options.ts";

describe("thinking token budgets", () => {
  it("includes xhigh and max between high and ultra", () => {
    assert.equal(DEFAULT_THINKING_BUDGETS.minimal, 1024);
    assert.equal(DEFAULT_THINKING_BUDGETS.low, 2048);
    assert.equal(DEFAULT_THINKING_BUDGETS.medium, 8192);
    assert.equal(DEFAULT_THINKING_BUDGETS.high, 16384);
    assert.equal(DEFAULT_THINKING_BUDGETS.xhigh, 24576);
    assert.equal(DEFAULT_THINKING_BUDGETS.max, 32768);
    assert.equal(DEFAULT_THINKING_BUDGETS.ultra, 32768);
  });

  it("still clamps extended effort to the high budget on the token-budget path", () => {
    const high = adjustMaxTokensForThinking(undefined, 64000, "high");
    const xhigh = adjustMaxTokensForThinking(undefined, 64000, "xhigh");
    const max = adjustMaxTokensForThinking(undefined, 64000, "max");
    const ultra = adjustMaxTokensForThinking(undefined, 64000, "ultra");
    assert.equal(high.thinkingBudget, DEFAULT_THINKING_BUDGETS.high);
    assert.equal(xhigh.thinkingBudget, DEFAULT_THINKING_BUDGETS.high);
    assert.equal(max.thinkingBudget, DEFAULT_THINKING_BUDGETS.high);
    assert.equal(ultra.thinkingBudget, DEFAULT_THINKING_BUDGETS.high);
  });
});
