import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CheckpointContext, LoopEvent, AgentRunPolicy } from "../src/loop.ts";
import { createAgentHistory, runAgentTurn, MaxTurnsExceededError, RunStoppedError } from "../src/loop.ts";
import { makeLlmConfig } from "../src/llm/index.ts";
import { PermissionManager } from "../src/permissions.ts";
import { resolveTuiRunOptions, runTuiAgentTurn, tuiContinuationPrompt } from "../src/tui/agent-turn.ts";
import { createInitialState, createTuiStore, type TuiAction } from "../src/tui/state.ts";
import { TurnRunner } from "../src/tui/tui-core/turn-runner.ts";
import { restoreTuiSession } from "../src/tui/session-serialization.ts";
import type { Tool } from "../src/tools/types.ts";
import type { AgentMessage } from "../src/types.ts";

const llm = makeLlmConfig({ apiKey: "test", baseUrl: "http://localhost/v1", model: "faux", contextWindow: 1_000_000 });
const echo: Tool = {
  name: "echo", description: "Simulated progress", parameters: { type: "object" },
  execute: async (args) => ({ content: `completed ${args.step}` }),
};
const reply = (step: number) => ({
  role: "assistant" as const, content: "", usage: { totalTokens: 12 },
  toolCalls: [{ id: `call-${step}`, name: "echo", arguments: { step } }],
});

// These tests deliberately ignore the developer's legacy limit and TUI budgets.
async function withDefaultEnv(work: () => Promise<void>): Promise<void> {
  const names = ["MINI_AGENT_MAX_TURNS", ...Object.keys(process.env).filter((key) => key.startsWith("MINI_AGENT_TUI_"))];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try { await work(); }
  finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function runnerFor(policy: AgentRunPolicy, chat: ConstructorParameters<typeof TurnRunner>[0]["chat"]) {
  const store = createTuiStore(createInitialState("faux"));
  const actions: TuiAction[] = [];
  const original = store.dispatch.bind(store);
  store.dispatch = (action) => { actions.push(action); original(action); };
  const checkpoints: CheckpointContext[] = [];
  const runner = new TurnRunner({
    store, llm, tools: [echo], permissionManager: new PermissionManager("bypass"),
    runPolicy: policy, chat, onCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint); },
  });
  return { store, actions, checkpoints, runner };
}

describe("TUI run configuration", () => {
  it("uses a policy by default and keeps explicit legacy hard stops", () => {
    assert.deepEqual(resolveTuiRunOptions({}, {}), { runPolicy: {
      maxCompactions: 8, emergencyIterationCap: 2000, stallPolicy: { sameActionLimit: 3, noProgressLimit: 6 },
    } });
    assert.deepEqual(resolveTuiRunOptions({}, { MINI_AGENT_MAX_TURNS: "2" }), { maxTurns: 2 });
    assert.deepEqual(resolveTuiRunOptions({ maxTurns: 0 }, { MINI_AGENT_MAX_TURNS: "2" }), { maxTurns: 0 });
    assert.deepEqual(resolveTuiRunOptions({ maxTurns: 1 }, { MINI_AGENT_MAX_TURNS: "2" }), { maxTurns: 1 });
    assert.equal(resolveTuiRunOptions({ runPolicy: { tokenBudget: 30 } }, { MINI_AGENT_MAX_TURNS: "1" }).runPolicy?.tokenBudget, 30);
  });

  it("loads and validates TUI budgets independently of Web configuration", () => {
    assert.deepEqual(resolveTuiRunOptions({ runPolicy: { tokenBudget: 60, stallPolicy: { sameActionLimit: 4 } } }, {
      MINI_AGENT_TUI_TOKEN_BUDGET: "100", MINI_AGENT_TUI_TOOL_CALL_BUDGET: "20",
      MINI_AGENT_TUI_WRITE_CALL_BUDGET: "10", MINI_AGENT_TUI_DEADLINE_MS: "300000",
      MINI_AGENT_TUI_MAX_COMPACTIONS: "5", MINI_AGENT_TUI_EMERGENCY_ITERATION_CAP: "600",
      MINI_AGENT_TUI_SAME_ACTION_LIMIT: "5", MINI_AGENT_TUI_NO_PROGRESS_LIMIT: "9",
      MINI_AGENT_WEB_TOKEN_BUDGET: "1",
    }), { runPolicy: {
      tokenBudget: 60, toolCallBudget: 20, writeCallBudget: 10, deadlineMs: 300000,
      maxCompactions: 5, emergencyIterationCap: 600, stallPolicy: { sameActionLimit: 4, noProgressLimit: 9 },
    } });
    for (const value of ["0", "-1", "1.5", "3x", "", "Infinity", "9007199254740992"]) {
      assert.throws(() => resolveTuiRunOptions({}, { MINI_AGENT_TUI_TOKEN_BUDGET: value }), /TOKEN_BUDGET|tokenBudget/);
    }
    for (const value of ["-1", "oops", "1.5", "Infinity"]) {
      assert.throws(() => resolveTuiRunOptions({}, { MINI_AGENT_MAX_TURNS: value }), /MAX_TURNS/);
    }
    assert.throws(() => resolveTuiRunOptions({ runPolicy: { emergencyIterationCap: 0 } }, {}), /emergencyIterationCap/);
  });
});

describe("TUI task execution and recovery", () => {
  it("finishes beyond 80 model turns without adding continuation prompts", async () => withDefaultEnv(async () => {
    let calls = 0;
    const events: LoopEvent[] = [];
    const result = await runTuiAgentTurn(createAgentHistory(), "finish a long task", {
      llm, tools: [echo], chat: async () => ++calls <= 81 ? reply(calls) : { role: "assistant", content: "finished" },
      onEvent: (event) => events.push(event),
    });
    assert.equal(calls, 82);
    assert.equal(result.stop, undefined);
    assert.equal(result.history.at(-1)?.content, "finished");
    assert.equal(result.history.filter((message) => message.role === "user").length, 1);
    assert.equal(events.filter((event) => event.type === "max_turns" || event.type === "run_stopped").length, 0);
  }));

  for (const [name, policy, expectedReason] of [
    ["tokens", { tokenBudget: 12 }, "budget_exhausted"],
    ["tools", { toolCallBudget: 1 }, "budget_exhausted"],
    ["safety", { emergencyIterationCap: 1 }, "safety_cap_reached"],
    ["stalled", { stallPolicy: { sameActionLimit: 1 } }, "stalled"],
  ] as const) {
    it(`pauses ${name} once without recording a model error`, async () => withDefaultEnv(async () => {
      let calls = 0;
      const { runner, store, actions, checkpoints } = runnerFor(
        policy,
        async () => name === "stalled" ? reply(1) : reply(++calls),
      );
      const result = await runner.submit("do work");
      assert.equal(result.succeeded, false);
      assert.equal(result.errorMessage, undefined);
      assert.equal(result.stop?.reason, expectedReason);
      assert.equal(result.history.at(-1)?.role, "tool");
      assert.equal(store.getState().busy, false);
      assert.equal(store.getState().taskStatus, "paused");
      assert.equal(store.getState().messages.filter((message) => message.kind === "error").length, 0);
      const notices = store.getState().messages.filter((message) => message.kind === "notice");
      assert.equal(notices.length, 1);
      assert.match(notices[0]!.text, /tokens.*tool calls.*writes/);
      assert.match(notices[0]!.text, /\/continue/);
      assert.equal(checkpoints.filter((checkpoint) => checkpoint.reason === "paused").length, 1);
      assert.equal(checkpoints.some((checkpoint) => checkpoint.reason === "failed"), false);
      assert.equal(actions.some((action) => action.type === "AUTO_CONTINUE"), false);
    }));
  }

  it("continues with a new budget and reuses saved tool results without another user message", async () => withDefaultEnv(async () => {
    let calls = 0;
    const { runner, store, actions } = runnerFor({ toolCallBudget: 1 }, async (_config, messages) => {
      calls += 1;
      if (calls <= 2) return reply(calls);
      assert.equal(messages.filter((message) => message.role === "user").length, 1);
      assert.deepEqual(messages.filter((message) => message.role === "tool").map((message) => message.content), ["completed 1", "completed 2"]);
      return { role: "assistant", content: "all work finished" };
    });
    assert.equal((await runner.submit("original task")).stop?.reason, "budget_exhausted");
    const second = await runner.submit("/continue");
    assert.equal(second.stop?.budgetUsage?.toolCallsUsed, 1, "a fresh local budget was charged");
    assert.equal(calls, 2);
    const final = await runner.submit("/continue");
    assert.equal(final.succeeded, true);
    assert.equal(store.getState().taskTitle, "original task");
    assert.equal(store.getState().taskStatus, "completed");
    assert.equal(store.getState().messages.filter((message) => message.kind === "user").length, 1);
    assert.equal(actions.filter((action) => action.type === "CONTINUE_TURN").length, 2);
  }));

  it("keeps an explicit maxTurns stop hard even when the environment requests more turns", async () => withDefaultEnv(async () => {
    process.env.MINI_AGENT_MAX_TURNS = "80";
    let calls = 0;
    const events: LoopEvent[] = [];
    const result = await runTuiAgentTurn([], "work", {
      llm, tools: [echo], maxTurns: 1, chat: async () => reply(++calls), onEvent: (event) => events.push(event),
    });
    assert.equal(calls, 1);
    assert.equal(result.stop?.reason, "safety_cap_reached");
    assert.equal(events.filter((event) => event.type === "run_stopped" && event.stopReason === "safety_cap_reached").length, 1);
    await assert.rejects(runAgentTurn([], "core hard stop", {
      llm, tools: [echo], maxTurns: 1, chat: async () => reply(++calls),
    }), (error: unknown) => error instanceof RunStoppedError && error.stopReason === "safety_cap_reached");
  }));

  it("rejects invalid Continue commands locally without spending a model request", async () => withDefaultEnv(async () => {
    const { runner, store } = runnerFor({}, async () => { throw new Error("must not call model"); });
    for (const prompt of ["/continue", "/continue extra"]) {
      assert.equal((await runner.submit(prompt)).succeeded, false);
      assert.equal(store.getState().busy, false);
    }
    assert.equal(runner.getHistory().filter((message) => message.role === "user").length, 0);
    assert.throws(() => tuiContinuationPrompt([]), /No task/);
  }));

  it("continues a restored checkpoint with its original user and completed tools", async () => withDefaultEnv(async () => {
    const saved: AgentMessage[] = [
      ...createAgentHistory(), { role: "user", content: "saved task" }, reply(1),
      { role: "tool", toolCallId: "call-1", name: "echo", content: "completed 1" },
    ];
    const restored = restoreTuiSession({ id: "saved", createdAt: 1, messages: saved }, "system");
    const { runner } = runnerFor({}, async (_config, messages) => {
      assert.equal(messages.at(-1)?.role, "tool");
      assert.equal(messages.filter((message) => message.role === "user").length, 1);
      return { role: "assistant", content: "resumed" };
    });
    runner.replaceHistory(restored.history);
    assert.equal((await runner.submit("/continue")).succeeded, true);
    assert.equal(runner.getHistory().at(-1)?.content, "resumed");
  }));
});
