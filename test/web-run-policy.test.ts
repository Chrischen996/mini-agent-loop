import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeLlmConfig } from "../src/llm/index.ts";
import { RunStoppedError, runAgentTurn, type AgentRunPolicy, type CheckpointContext, type LoopEvent } from "../src/loop.ts";
import { runServerAgentTurn } from "../src/server/turn-runner.ts";
import { loadDefaultWebRunPolicyFromEnv, resolveContinueRun, resolveWebRunPolicy } from "../src/server/run-policy.ts";
import type { WebRunState } from "../src/session-store.ts";
import type { Tool } from "../src/tools/types.ts";
import type { AgentMessage } from "../src/types.ts";

const llm = makeLlmConfig({ apiKey: "test", baseUrl: "http://localhost/v1", model: "faux" });
const write: Tool = {
  name: "write", description: "Simulated write", parameters: { type: "object", properties: {} },
  execute: async () => ({ content: "written" }),
};
const reply = (id: number) => ({
  role: "assistant" as const, content: "", usage: { totalTokens: 12 },
  toolCalls: [{ id: `write-${id}`, name: "write", arguments: { value: id } }],
});

function stopped(reason: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof RunStoppedError);
    assert.equal(error.stopReason, reason);
    return true;
  };
}

describe("Web policy configuration", () => {
  it("loads all budget and stall environment fields", () => {
    assert.deepEqual(loadDefaultWebRunPolicyFromEnv({
      MINI_AGENT_WEB_TOKEN_BUDGET: "50000", MINI_AGENT_WEB_TOOL_CALL_BUDGET: "100",
      MINI_AGENT_WEB_WRITE_CALL_BUDGET: "20", MINI_AGENT_WEB_DEADLINE_MS: "300000",
      MINI_AGENT_WEB_MAX_COMPACTIONS: "4", MINI_AGENT_WEB_EMERGENCY_ITERATION_CAP: "500",
      MINI_AGENT_WEB_SAME_ACTION_LIMIT: "5", MINI_AGENT_WEB_NO_PROGRESS_LIMIT: "9",
    }), {
      tokenBudget: 50000, toolCallBudget: 100, writeCallBudget: 20, deadlineMs: 300000,
      maxCompactions: 4, emergencyIterationCap: 500, stallPolicy: { sameActionLimit: 5, noProgressLimit: 9 },
    });
  });

  it("rejects malformed and out-of-range configuration instead of truncating it", () => {
    for (const value of ["0", "-1", "3oops", "1.5", "Infinity", "", "9007199254740992"]) {
      assert.throws(() => loadDefaultWebRunPolicyFromEnv({ MINI_AGENT_WEB_TOKEN_BUDGET: value }), /TOKEN_BUDGET/);
    }
    assert.throws(() => resolveWebRunPolicy({ emergencyIterationCap: 0 }), /emergencyIterationCap/);
    assert.throws(() => resolveWebRunPolicy({ stallPolicy: { noProgressLimit: 1.5 } }), /noProgressLimit/);
    assert.deepEqual(resolveWebRunPolicy({ stallPolicy: { sameActionLimit: 7 } }).stallPolicy, {
      sameActionLimit: 7, noProgressLimit: 6,
    });
  });

  it("merges explicit fields over environment and retains omitted defaults", () => {
    const policy = resolveWebRunPolicy({ tokenBudget: 70, deadlineMs: undefined, stallPolicy: { sameActionLimit: 4 } }, {
      MINI_AGENT_WEB_TOKEN_BUDGET: "100", MINI_AGENT_WEB_DEADLINE_MS: "300000",
      MINI_AGENT_WEB_NO_PROGRESS_LIMIT: "9",
    });
    assert.equal(policy.tokenBudget, 70);
    assert.equal(policy.deadlineMs, 300000);
    assert.equal(policy.maxCompactions, 8);
    assert.deepEqual(policy.stallPolicy, { sameActionLimit: 4, noProgressLimit: 9 });
  });

  it("validates Continue limits and distinguishes new and remaining allocations", () => {
    const defaults = { tokenBudget: 100, emergencyIterationCap: 10 };
    assert.equal(resolveContinueRun({ tokenBudget: 50, deadlineMs: 300000 }, defaults).runPolicy?.tokenBudget, 50);
    for (const input of [{ tokenBudget: 0 }, { deadlineMs: "3000" }, { typo: 1 }, [], "bad", { budgetMode: "old" }]) {
      assert.throws(() => resolveContinueRun(input, defaults));
    }
    assert.throws(() => resolveContinueRun({ budgetMode: "remaining" }, defaults), /No saved/);
    const saved: WebRunState = {
      runId: "previous", status: "interrupted", stepsUsed: 1, maxSteps: 10, checkpointRevision: 1,
      budgetPolicy: defaults, budgetUsage: { tokensUsed: 50 },
    };
    assert.equal(resolveContinueRun({ budgetMode: "remaining" }, defaults, saved).runPolicy, defaults);
    assert.throws(() => resolveContinueRun({ budgetMode: "remaining", tokenBudget: 20 }, defaults, saved), /cannot include/);
  });
});

describe("durable Web policy stops", () => {
  for (const [name, policy] of Object.entries<AgentRunPolicy>({
    tokens: { tokenBudget: 12 }, tools: { toolCallBudget: 1 }, writes: { writeCallBudget: 1 },
    deadline: { deadlineMs: 1 }, safety: { emergencyIterationCap: 1 },
    stalled: { stallPolicy: { sameActionLimit: 1 } },
  })) {
    it(`saves ${name} stops once with usage before emitting the stop event`, async () => {
      let calls = 0;
      const states: WebRunState[] = [];
      const events: LoopEvent[] = [];
      const reason = name === "safety" ? "safety_cap_reached" : name === "stalled" ? "stalled" : "budget_exhausted";
      await assert.rejects(runServerAgentTurn([], "write", {
        loop: {
          llm, tools: [write],
          chat: async () => reply(name === "stalled" ? (calls++, 1) : ++calls),
          onEvent: (event) => {
            if (event.type === "run_stopped") {
              assert.equal(states.at(-1)?.status, "paused");
              assert.equal(states.at(-1)?.reason, reason);
              assert.deepEqual(event.budgetUsage, states.at(-1)?.budgetUsage);
            }
            events.push(event);
          },
        },
        runPolicy: policy,
        // A pre-consumed deadline makes the time test deterministic.
        budgetMode: name === "deadline" ? "remaining" : "new",
        previousRunState: name === "deadline" ? {
          runId: "prior", status: "interrupted", stepsUsed: 0, maxSteps: 2000, checkpointRevision: 1,
          budgetUsage: { elapsedMs: 1 },
        } : undefined,
        persistCheckpoint: async (_messages, state) => { states.push(structuredClone(state)); },
      }), stopped(reason));
      assert.equal(states.filter((s) => s.status === "paused").length, 1);
      assert.equal(states.some((s) => s.status === "failed" || s.reason === "model_error" || s.reason === "step_limit"), false);
      assert.equal(events.filter((e) => e.type === "run_stopped").length, 1);
      assert.equal(events.some((e) => e.type === "done" || e.type === "error" || e.type === "max_turns"), false);
      const final = states.at(-1)!;
      assert.equal(final.budgetUsage?.tokensUsed, calls * 12);
      assert.equal(final.budgetUsage?.toolCallsUsed, calls);
      assert.equal(final.budgetUsage?.writeCallsUsed, calls);
      if (calls) assert.match(final.lastFingerprint!, /^[a-f0-9]{64}$/);
    });
  }

  it("does not emit a stop or retry persistence when saving the pause fails", async () => {
    const events: LoopEvent[] = [];
    let writes = 0;
    await assert.rejects(runServerAgentTurn([], "write", {
      loop: { llm, tools: [write], chat: async () => reply(1), onEvent: (e) => events.push(e) },
      runPolicy: { toolCallBudget: 1 },
      persistCheckpoint: async (_messages, state) => {
        writes++;
        if (state.status === "paused") throw new Error("disk full");
      },
    }), /disk full/);
    assert.equal(writes, 3); // before_tool, tool_result, paused
    assert.equal(events.some((e) => e.type === "run_stopped" || e.type === "done"), false);
  });

  it("separates allocation usage from cumulative usage and preserves remaining budget", async () => {
    let previous: WebRunState | undefined;
    let history: AgentMessage[] = [];
    let calls = 0;
    const run = async (budgetMode: "new" | "remaining") => {
      await assert.rejects(runServerAgentTurn(history, "write", {
        loop: { llm, tools: [write], chat: async () => reply(++calls) },
        runPolicy: { toolCallBudget: 1 }, previousRunState: previous, budgetMode, isResume: Boolean(previous),
        persistCheckpoint: async (messages, state) => { history = messages; previous = structuredClone(state); },
      }), stopped("budget_exhausted"));
    };
    await run("new");
    const fingerprint = previous!.lastFingerprint;
    await run("remaining");
    assert.equal(calls, 1);
    assert.equal(previous!.lastFingerprint, fingerprint);
    assert.equal(previous!.cumulativeBudgetUsage?.tokensUsed, 12);
    await run("new");
    assert.equal(calls, 2);
    assert.equal(previous!.budgetUsage?.tokensUsed, 12);
    assert.equal(previous!.cumulativeBudgetUsage?.tokensUsed, 24);
    assert.equal(previous!.cumulativeBudgetUsage?.toolCallsUsed, 2);
    assert.equal(history.filter((m) => m.role === "user").length, 1);
  });

  it("checkpoints policy context overflow as recoverable instead of failed", async () => {
    const checkpoints: CheckpointContext[] = [];
    await assert.rejects(runAgentTurn([], "question", {
      llm, tools: [], runPolicy: { maxCompactions: 1 }, context: { maxCompactionRetries: 0 },
      chat: async () => { throw new Error("context length exceeded"); },
      onCheckpoint: async (ctx) => { checkpoints.push(ctx); },
    }), stopped("context_exhausted"));
    assert.deepEqual(checkpoints.map((ctx) => [ctx.reason, ctx.stopReason]), [["paused", "context_exhausted"]]);
  });

  it("counts initial history compaction and emits no compaction event after its allowance is exhausted", async () => {
    const events: LoopEvent[] = [];
    const checkpoints: CheckpointContext[] = [];
    let calls = 0;
    const history: AgentMessage[] = Array.from({ length: 6 }, (_, index) => ({
      role: "user", content: `history ${index} ${"x".repeat(100)}`,
    }));
    await assert.rejects(runAgentTurn(history, "latest", {
      llm, tools: [], runPolicy: { maxCompactions: 1 },
      context: { maxChars: 100, keepRecentMessages: 3 },
      chat: async () => { calls++; throw new Error("context length exceeded"); },
      onEvent: (event) => events.push(event),
      onCheckpoint: async (ctx) => { checkpoints.push(ctx); },
    }), stopped("context_exhausted"));
    assert.equal(calls, 1);
    assert.equal(events.filter((event) => event.type === "context_compacted").length, 1);
    assert.deepEqual(checkpoints.map((ctx) => ctx.reason), ["context_compacted", "paused"]);
    assert.equal(events.at(-1)?.type, "run_stopped");
  });

  it("counts automatic preflight tools toward the same tool budget", async () => {
    let delegations = 0;
    const subagent: Tool = {
      name: "subagent", description: "Collect a summary", parameters: { type: "object", properties: {} },
      execute: async () => { delegations++; return { content: "summary" }; },
    };
    await assert.rejects(runAgentTurn([], "Analyze code and delegate research", {
      llm, tools: [subagent], runPolicy: { toolCallBudget: 1 }, autoSubagent: { enabled: true, minScore: 0 },
      chat: async () => { throw new Error("The budget must stop before the first model request"); },
    }), (error) => {
      assert.ok(error instanceof RunStoppedError);
      assert.equal(error.budgetUsage?.toolCallsUsed, delegations);
      return true;
    });
    assert.equal(delegations, 1);
  });
});
