import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSystemPrompt } from "../src/loop/prompt.ts";
import { buildTuiSystemPrompt } from "../src/tui/system-prompt.ts";
import { createRequestPermissionModeTool } from "../src/tools/mode-request.ts";
import { resolveToolProvider, type Tool } from "../src/tools/types.ts";

/**
 * The `request_permission_mode` guidance is a *client* fact, not a model fact.
 *
 * Regression: it used to live in `MODE_SUFFIX`, which is shared by the CLI,
 * the HTTP server and every subagent. Headless clients were therefore told to
 * call a tool that was not in their tool list, and child agents were told to
 * call a tool their parent explicitly strips.
 */
describe("mode-request guidance is gated on client capability", () => {
  it("omits the tool name when the client cannot confirm it", () => {
    const prompt = buildSystemPrompt("plan");
    assert.doesNotMatch(prompt, /request_permission_mode/);
    // The prose fallback must still exist, or the model has no escalation path.
    assert.match(prompt, /tell the user which mode to switch to/i);
  });

  it("includes the tool name only when the client advertises it", () => {
    const prompt = buildSystemPrompt("plan", undefined, undefined, { modeRequest: true });
    assert.match(prompt, /request_permission_mode/);
    assert.doesNotMatch(prompt, /tell the user which mode to switch to/i);
    // The end-of-turn exception only exists for clients that can confirm.
    assert.match(prompt, /ends the turn by design/);
  });

  it("keeps the mode suffix free of tool names for every mode", () => {
    for (const mode of ["plan", "bypass"] as const) {
      const prompt = buildSystemPrompt(mode);
      assert.doesNotMatch(prompt, /request_permission_mode/, `${mode} suffix must not name the tool`);
      assert.match(prompt, new RegExp(`mode=${mode}`));
    }
  });

  it("keeps the end-of-turn rule intact when the tool is absent", () => {
    const prompt = buildSystemPrompt("bypass");
    assert.match(prompt, /Complete ALL steps in a single response/);
    assert.doesNotMatch(prompt, /ends the turn by design/);
  });

  it("is what the TUI builds, and what a headless client does not", () => {
    assert.match(buildTuiSystemPrompt("plan"), /request_permission_mode/);
    assert.doesNotMatch(buildSystemPrompt("plan"), /request_permission_mode/);
  });

  it("is detected from the tool provider, not from a caller flag", () => {
    // `runAgentLoop` derives the capability from the resolved tool set so the
    // prompt can never claim a tool the model cannot call.
    const withTool = resolveToolProvider([createRequestPermissionModeTool() as Tool]);
    const withoutTool = resolveToolProvider([]);
    assert.equal(withTool.some((tool) => tool.name === "request_permission_mode"), true);
    assert.equal(withoutTool.some((tool) => tool.name === "request_permission_mode"), false);
  });
});
