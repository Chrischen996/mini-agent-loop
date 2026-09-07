import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapStopReason } from "../src/pi-ai/api/anthropic-messages.ts";

describe("Anthropic stop reason mapping", () => {
  it("maps known Anthropic stop reasons", () => {
    assert.equal(mapStopReason("end_turn").stopReason, "stop");
    assert.equal(mapStopReason("max_tokens").stopReason, "length");
    assert.equal(mapStopReason("tool_use").stopReason, "toolUse");
    assert.equal(mapStopReason("pause_turn").stopReason, "stop");
    assert.equal(mapStopReason("stop_sequence").stopReason, "stop");
    assert.equal(mapStopReason("sensitive").stopReason, "error");
    assert.equal(mapStopReason("refusal").stopReason, "error");
  });

  it("does not throw on unknown future stop reasons", () => {
    const result = mapStopReason("model_context_window_exceeded");
    assert.equal(result.stopReason, "stop");
    assert.match(result.errorMessage ?? "", /model_context_window_exceeded/);
  });
});
