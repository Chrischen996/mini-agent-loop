/**
 * Grok Build-style subagent budget tests:
 *
 * - Shared call budget (`agentBudgetCalls` / `callsLimit`): per-launch
 *   counting, launch rejection at exhaustion, and pre-launch panel
 *   rejection for sync batches, async submissions, and pipeline waves.
 * - `dynamic` budget strategy: wave-level rebalancing of the remaining
 *   global token budget across dependency waves.
 * - `rate_limit` error classification.
 *
 * Follows the faux-LLM conventions of test/subagent.test.ts: a dummy LLM
 * config with model "faux" plus an injected faux `chat`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contentAsString } from "../src/content.ts";
import { makeLlmConfig, type ChatFn } from "../src/llm/index.ts";
import {
  createSubagentBatchTool,
  createSubagentTool,
  type GlobalBudgetState,
} from "../src/subagent/index.ts";
import type { SubagentEvent } from "../src/subagent/types.ts";
import { PipelineOrchestrator } from "../src/orchestration/pipeline/orchestrator.ts";
import type { TaskSpec } from "../src/orchestration/pipeline/types.ts";
import { REVIEW_VERDICT_MARKER } from "../src/orchestration/pipeline/orchestrator.ts";

// ─── Shared helpers ──────────────────────────────────────────────────────────

const dummyLlm = makeLlmConfig({
  apiKey: "test-key",
  baseUrl: "http://localhost/v1",
  model: "faux",
});

function createTrackingChat(text = "ok") {
  let launches = 0;
  const chat: ChatFn = async () => {
    launches += 1;
    return { role: "assistant", content: text };
  };
  return { chat, launches: () => launches };
}

// ─── Single subagent call budget ──────────────────────────────────────────────

describe("subagent call budget (single)", () => {
  it("counts launches against the shared call budget and rejects at exhaustion", async () => {
    const state: GlobalBudgetState = { used: 0, callsUsed: 0, callsLimit: 2 };
    const { chat, launches } = createTrackingChat();
    const tool = createSubagentTool({
      parentLlm: dummyLlm,
      parentTools: [],
      globalBudgetState: state,
      chat,
    });

    const r1 = await tool.execute({ task: "one" });
    const r2 = await tool.execute({ task: "two" });
    assert.equal(r1.isError, undefined);
    assert.equal(r2.isError, undefined);
    assert.equal(state.callsUsed, 2);

    const r3 = await tool.execute({ task: "three" });
    assert.equal(r3.isError, true);
    assert.match(contentAsString(r3.content), /call budget exhausted/i);
    assert.equal(launches(), 2, "exhausted budget must not launch a subagent");
  });

  it("agentBudgetCalls option builds the shared call-budget state automatically", async () => {
    const { chat } = createTrackingChat();
    const tool = createSubagentTool({
      parentLlm: dummyLlm,
      parentTools: [],
      agentBudgetCalls: 1,
      chat,
    });

    const r1 = await tool.execute({ task: "a" });
    assert.equal(r1.isError, undefined);
    const r2 = await tool.execute({ task: "b" });
    assert.equal(r2.isError, true);
    assert.match(contentAsString(r2.content), /call budget exhausted/i);
  });
});

// ─── Batch panel rejection ────────────────────────────────────────────────────

describe("subagent call budget (batch panels)", () => {
  it("rejects an over-budget sync panel before launching any subagent", async () => {
    const state: GlobalBudgetState = { used: 0, callsUsed: 0, callsLimit: 2 };
    const { chat, launches } = createTrackingChat();
    const batch = createSubagentBatchTool({
      parentLlm: dummyLlm,
      parentTools: [],
      globalBudgetState: state,
      chat,
    });

    const result = await batch.execute({
      tasks: [
        { label: "a", task: "a" },
        { label: "b", task: "b" },
        { label: "c", task: "c" },
      ],
    });
    assert.equal(result.isError, true);
    const text = contentAsString(result.content);
    assert.match(text, /call budget exhausted/i);
    assert.match(text, /before launch/i);
    assert.equal(launches(), 0, "panel rejection must not launch any subagent");
    assert.equal(state.callsUsed, 0);
  });

  it("runs a panel that fits the call budget and consumes it", async () => {
    const state: GlobalBudgetState = { used: 0, callsUsed: 0, callsLimit: 3 };
    const { chat } = createTrackingChat();
    const batch = createSubagentBatchTool({
      parentLlm: dummyLlm,
      parentTools: [],
      globalBudgetState: state,
      chat,
    });

    const result = await batch.execute({
      tasks: [
        { label: "a", task: "a" },
        { label: "b", task: "b" },
        { label: "c", task: "c" },
      ],
    });
    assert.equal(result.isError, undefined);
    assert.equal(state.callsUsed, 3);

    // The next panel of one call now fails the pre-launch check.
    const result2 = await batch.execute({
      tasks: [{ label: "d", task: "d" }],
    });
    assert.equal(result2.isError, true);
    assert.match(contentAsString(result2.content), /call budget exhausted/i);
  });

  it("rejects an over-budget async panel at submit time", async () => {
    const state: GlobalBudgetState = { used: 0, callsUsed: 1, callsLimit: 2 };
    const { chat, launches } = createTrackingChat();
    const batch = createSubagentBatchTool({
      parentLlm: dummyLlm,
      parentTools: [],
      globalBudgetState: state,
      chat,
    });

    const result = await batch.execute({
      mode: "async",
      tasks: [
        { label: "a", task: "a" },
        { label: "b", task: "b" },
        { label: "c", task: "c" },
      ],
    });
    assert.equal(result.isError, true);
    assert.match(contentAsString(result.content), /call budget exhausted/i);
    assert.equal(launches(), 0);
  });
});

// ─── Dynamic wave-level rebalancing ──────────────────────────────────────────

function makeUsageChat(usages: number[]): ChatFn {
  let index = 0;
  return async () => {
    const tokens = usages[index] ?? 0;
    index += 1;
    return {
      role: "assistant",
      content: `done (${tokens})`,
      usage: {
        promptTokens: tokens,
        inputTokens: tokens,
        completionTokens: 0,
        totalTokens: tokens,
      },
    };
  };
}

const dynamicTasks = [
  { label: "a", task: "a" },
  { label: "b", task: "b" },
  { label: "c", task: "c", dependsOn: ["a"] },
];

describe("dynamic budget strategy (wave-level rebalancing)", () => {
  it("re-splits the remaining token budget per wave, later waves inherit savings", async () => {
    // Global 100. Wave 1 (a,b): 15+15 used → 70 remain. Wave 2 (c): share 70.
    // c consumes 40, which fits the dynamic share (70) but NOT the flat
    // equal share (floor(100/3) = 33).
    const state: GlobalBudgetState = { used: 0, limit: 100 };
    const batch = createSubagentBatchTool({
      parentLlm: dummyLlm,
      parentTools: [],
      globalBudgetState: state,
      chat: makeUsageChat([15, 15, 40]),
    });

    const result = await batch.execute({
      tasks: dynamicTasks,
      maxConcurrency: 1,
      budgetAllocation: { strategy: "dynamic" },
    });
    const text = contentAsString(result.content);
    assert.equal(result.isError, undefined, `expected all waves to pass: ${text}`);
    assert.match(text, /── a ──[\s\S]*done \(15\)/);
    assert.match(text, /── b ──[\s\S]*done \(15\)/);
    assert.match(text, /── c ──[\s\S]*done \(40\)/);
  });

  it("the same workload fails under the flat `equal` strategy", async () => {
    const state: GlobalBudgetState = { used: 0, limit: 100 };
    const batch = createSubagentBatchTool({
      parentLlm: dummyLlm,
      parentTools: [],
      globalBudgetState: state,
      chat: makeUsageChat([15, 15, 40]),
    });

    const result = await batch.execute({
      tasks: dynamicTasks,
      maxConcurrency: 1,
      budgetAllocation: { strategy: "equal" },
    });
    assert.equal(result.isError, true);
    assert.match(contentAsString(result.content), /token budget exceeded/i);
  });

  it("rejects a cyclic graph when the dynamic strategy is requested", async () => {
    const state: GlobalBudgetState = { used: 0, limit: 100 };
    const { chat } = createTrackingChat();
    const batch = createSubagentBatchTool({
      parentLlm: dummyLlm,
      parentTools: [],
      globalBudgetState: state,
      chat,
    });

    const result = await batch.execute({
      tasks: [
        { label: "a", task: "a", dependsOn: ["b"] },
        { label: "b", task: "b", dependsOn: ["a"] },
      ],
      budgetAllocation: { strategy: "dynamic" },
    });
    assert.equal(result.isError, true);
    assert.match(contentAsString(result.content), /cycle/i);
  });
});

// ─── Rate-limit classification ────────────────────────────────────────────────

describe("rate_limit error classification", () => {
  it("classifies 429 / rate-limit provider failures as rate_limit", async () => {
    const events: SubagentEvent[] = [];
    const tool = createSubagentTool({
      parentLlm: dummyLlm,
      parentTools: [],
      onSubagentEvent: (event) => events.push(event),
      chat: async () => {
        throw new Error("HTTP 429: rate limit exceeded");
      },
    });

    const result = await tool.execute({ task: "x" });
    assert.equal(result.isError, true);
    assert.match(contentAsString(result.content), /rate_limit/);
    const end = events.find((event) => event.type === "subagent_end");
    assert.ok(end && end.type === "subagent_end");
    if (end?.type === "subagent_end") {
      assert.equal(end.errors?.at(-1)?.kind, "rate_limit");
    }
  });

  it("keeps token budget failures classified as budget, not rate_limit", async () => {
    const tool = createSubagentTool({
      parentLlm: dummyLlm,
      parentTools: [],
      chat: async () => ({
        role: "assistant",
        content: "tokens",
        usage: {
          promptTokens: 200,
          inputTokens: 200,
          completionTokens: 0,
          totalTokens: 200,
        },
      }),
    });

    const result = await tool.execute({ task: "x", tokenBudget: 100 });
    assert.equal(result.isError, true);
    assert.match(contentAsString(result.content), /token budget exceeded/i);
    assert.doesNotMatch(contentAsString(result.content), /rate_limit/);
  });
});

// ─── Pipeline orchestrator wave gating ────────────────────────────────────────

function makePipelineSpec(id: string, overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id,
    title: `task ${id}`,
    context: "project context",
    instruction: "implement the feature",
    acceptance: ["feature works"],
    files_hint: [`src/${id}.ts`],
    ...overrides,
  };
}

function createPipelineChat() {
  let workerCalls = 0;
  let reviewerCalls = 0;
  const chat: ChatFn = async (_config, messages) => {
    const prompt = contentAsString(
      messages.find((m) => m.role === "user")?.content ?? "",
    );
    if (prompt.includes(REVIEW_VERDICT_MARKER)) {
      reviewerCalls += 1;
      return { role: "assistant", content: JSON.stringify({ passed: true, failed_items: [] }) };
    }
    workerCalls += 1;
    // Status defaults to "done" when omitted; the orchestrator forces the id.
    return { role: "assistant", content: "```json\n" + JSON.stringify({ status: "done" }) + "\n```" };
  };
  return { chat, workerCalls: () => workerCalls, reviewerCalls: () => reviewerCalls };
}

describe("pipeline orchestrator call-budget wave gating", () => {
  it("blocks an over-budget wave before dispatching any task (dispatchAll)", async () => {
    const { chat, workerCalls } = createPipelineChat();
    const orchestrator = new PipelineOrchestrator({
      parentLlm: dummyLlm,
      parentTools: [],
      chat,
      agentBudgetCalls: 2,
    });

    const results = await orchestrator.dispatchAll([
      makePipelineSpec("T-1"),
      makePipelineSpec("T-2"),
      makePipelineSpec("T-3"),
    ]);
    assert.equal(results.length, 3);
    for (const result of results) {
      assert.equal(result.status, "blocked");
      assert.match(result.message, /call budget exhausted/i);
    }
    assert.equal(workerCalls(), 0, "wave rejection must not dispatch any worker");
  });

  it("dispatches a wave that fits the call budget", async () => {
    const { chat, workerCalls } = createPipelineChat();
    const orchestrator = new PipelineOrchestrator({
      parentLlm: dummyLlm,
      parentTools: [],
      chat,
      agentBudgetCalls: 3,
    });

    const results = await orchestrator.dispatchAll([
      makePipelineSpec("T-1"),
      makePipelineSpec("T-2"),
      makePipelineSpec("T-3"),
    ]);
    assert.ok(results.every((result) => result.status === "done"));
    assert.equal(workerCalls(), 3);
  });

  it("blocks over-budget waves in run() without dispatching", async () => {
    const { chat, workerCalls } = createPipelineChat();
    const orchestrator = new PipelineOrchestrator({
      parentLlm: dummyLlm,
      parentTools: [],
      chat,
      agentBudgetCalls: 2,
    });

    const summary = await orchestrator.run([
      makePipelineSpec("T-1"),
      makePipelineSpec("T-2"),
      makePipelineSpec("T-3"),
    ]);
    assert.equal(summary.ok, false);
    assert.equal(summary.entries.length, 3);
    for (const entry of summary.entries) {
      assert.equal(entry.result.status, "blocked");
      assert.match(entry.result.message, /call budget exhausted/i);
    }
    assert.equal(workerCalls(), 0);
  });
});
