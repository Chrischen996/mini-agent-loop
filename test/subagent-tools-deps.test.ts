import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSubagentToolsDeps, type SubagentToolsDepsInput } from "../src/tui/subagent-tools-deps.ts";
import { makeLlmConfig } from "../src/llm/index.ts";

const llm = makeLlmConfig({ apiKey: "k", baseUrl: "http://localhost/v1", model: "faux" });

function baseInput(overrides: Partial<SubagentToolsDepsInput> = {}): SubagentToolsDepsInput {
  return {
    parentLlm: llm,
    parentTools: {} as SubagentToolsDepsInput["parentTools"],
    taskRegistry: { get: async () => undefined } as never,
    onSubagentEvent: () => undefined,
    getPermissionTurn: () => undefined,
    getBackgroundPermissionTurn: () => ({}) as never,
    parentRuntime: {},
    sessionRoleLlmConfigs: {},
    worktreeSourceCwd: "/proj",
    ...overrides,
  };
}

describe("buildSubagentToolsDeps", () => {
  it("expands a vision config into a one-element preprocessor list", () => {
    const vision = { enabled: true } as never;
    const deps = buildSubagentToolsDeps(baseInput({ vision }));
    assert.equal(deps.visionPreprocessors.length, 1);

    const without = buildSubagentToolsDeps(baseInput({ vision: undefined }));
    assert.deepEqual(without.visionPreprocessors, []);
  });

  it("omits a falsy session concurrency limit instead of passing 0", () => {
    const withLimit = buildSubagentToolsDeps(baseInput({ sessionConcurrencyLimit: 3 }));
    assert.equal((withLimit as { sessionConcurrencyLimit?: number }).sessionConcurrencyLimit, 3);

    const zero = buildSubagentToolsDeps(baseInput({ sessionConcurrencyLimit: 0 })) as { sessionConcurrencyLimit?: number };
    assert.equal("sessionConcurrencyLimit" in zero, false, "0 must be omitted like the original spread");
    assert.equal("sessionConcurrencyLimit" in buildSubagentToolsDeps(baseInput()), false);
  });

  it("passes live values through unchanged for the factory's value comparison", () => {
    const sessionRoleLlmConfigs = { reviewer: llm };
    const parentRuntime = { history: [] };
    const deps = buildSubagentToolsDeps(baseInput({
      globalTokenBudget: 5000,
      globalConcurrencyLimit: 4,
      roleLlmConfigs: { planner: llm },
      sessionRoleLlmConfigs,
      parentRuntime: parentRuntime as never,
    }));

    assert.equal(deps.globalTokenBudget, 5000);
    assert.equal(deps.globalConcurrencyLimit, 4);
    assert.deepEqual(deps.roleLlmConfigs, { planner: llm });
    // Identity preserved: the factory compares these by JSON value, and the
    // component reads them fresh from a ref on every call.
    assert.equal(deps.sessionRoleLlmConfigs, sessionRoleLlmConfigs);
    assert.equal(deps.parentRuntime, parentRuntime);
    assert.equal(deps.worktreeSourceCwd, "/proj");
    assert.equal(deps.parentLlm, llm);
  });

  it("forwards the callbacks as-is", () => {
    let called = false;
    const onSubagentEvent = () => { called = true; };
    const deps = buildSubagentToolsDeps(baseInput({ onSubagentEvent }));
    deps.onSubagentEvent({ type: "subagent_start", id: "x", task: "t", depth: 1, runtime: {} as never });
    assert.equal(called, true);
    assert.equal(deps.getPermissionTurn(), undefined);
    assert.ok(deps.getBackgroundPermissionTurn!());
    assert.ok(deps.taskRegistry);
  });
});
