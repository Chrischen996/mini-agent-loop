import assert from "node:assert/strict";
import test from "node:test";
import { isTuiFeatureEnabled } from "../src/tui/execution-policy.ts";

test("TUI features are enabled by default", () => {
  assert.equal(isTuiFeatureEnabled(undefined), true);
  assert.equal(isTuiFeatureEnabled("1"), true);
  assert.equal(isTuiFeatureEnabled("yes"), true);
});

test("TUI features accept explicit opt-out values", () => {
  for (const value of ["0", "false", "off", "no", " FALSE "]) {
    assert.equal(isTuiFeatureEnabled(value), false, value);
  }
});
