import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapThinkingLevelToEffort } from "../src/pi-ai/api/anthropic-messages.ts";
import type { Model } from "../src/pi-ai/types.ts";

const unmapped = {
  id: "claude-sonnet-4-6",
  api: "anthropic-messages",
  provider: "anthropic",
  reasoning: true,
} as Model<"anthropic-messages">;

const mapped = {
  ...unmapped,
  id: "claude-opus-4-7",
  thinkingLevelMap: { xhigh: "xhigh", max: "max" },
} as Model<"anthropic-messages">;

describe("anthropic thinking effort mapping", () => {
  it("falls back without inventing native xhigh", () => {
    assert.equal(mapThinkingLevelToEffort(unmapped, "low"), "low");
    assert.equal(mapThinkingLevelToEffort(unmapped, "medium"), "medium");
    assert.equal(mapThinkingLevelToEffort(unmapped, "high"), "high");
    assert.equal(mapThinkingLevelToEffort(unmapped, "xhigh"), "high");
    assert.equal(mapThinkingLevelToEffort(unmapped, "max"), "max");
    assert.equal(mapThinkingLevelToEffort(unmapped, "ultra"), "max");
  });

  it("honors an explicit xhigh mapping", () => {
    assert.equal(mapThinkingLevelToEffort(mapped, "xhigh"), "xhigh");
    assert.equal(mapThinkingLevelToEffort(mapped, "max"), "max");
    assert.equal(mapThinkingLevelToEffort(mapped, "ultra"), "max");
  });
});
