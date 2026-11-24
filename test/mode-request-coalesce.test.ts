import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coalesceModeRequests } from "../src/loop/tool-execution.ts";
import { MODE_REQUEST_TOOL_NAME } from "../src/tools/mode-request.ts";
import type { ToolResult } from "../src/tools/types.ts";

const request = (mode: "plan" | "bypass", reason = "because"): ToolResult => ({
  content: `Recorded a request to switch to ${mode} mode.`,
  modeRequest: { mode, reason },
});

describe("coalescing mode requests in one assistant response", () => {
  it("keeps the last request and rewrites the superseded ones", () => {
    const results = [request("bypass"), request("plan")];
    const kept = coalesceModeRequests(results);
    assert.equal(kept, 1);
    // The earlier request must not reach the client as a card.
    assert.equal(results[0]?.modeRequest, undefined);
    assert.match(String(results[0]?.content), /Superseded/);
    assert.match(String(results[0]?.content), /bypass/);
    // The surviving one is untouched.
    assert.deepEqual(results[1]?.modeRequest, { mode: "plan", reason: "because" });
  });

  it("leaves a single request alone", () => {
    const results = [request("bypass")];
    assert.equal(coalesceModeRequests(results), 0);
    assert.deepEqual(results[0]?.modeRequest, { mode: "bypass", reason: "because" });
    assert.doesNotMatch(String(results[0]?.content), /Superseded/);
  });

  it("ignores results that are not mode requests", () => {
    const plain: ToolResult = { content: "read ok" };
    const results = [plain, request("bypass"), plain];
    assert.equal(coalesceModeRequests(results), 1);
    assert.deepEqual(results[1]?.modeRequest, { mode: "bypass", reason: "because" });
    assert.equal(results[0]?.content, "read ok");
    assert.equal(results[2]?.content, "read ok");
  });

  it("returns undefined when nothing requested a mode change", () => {
    assert.equal(coalesceModeRequests([{ content: "a" }, { content: "b" }]), undefined);
    assert.equal(coalesceModeRequests([]), undefined);
  });

  it("is idempotent", () => {
    const results = [request("bypass"), request("plan")];
    coalesceModeRequests(results);
    const before = results.map((result) => result.content);
    assert.equal(coalesceModeRequests(results), 1);
    assert.deepEqual(results.map((result) => result.content), before);
  });

  it("uses the tool name constant the tool actually registers", () => {
    assert.equal(MODE_REQUEST_TOOL_NAME, "request_permission_mode");
  });
});
