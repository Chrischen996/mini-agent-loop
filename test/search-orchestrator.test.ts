/**
 * Search-then-orchestrate workflow tests — faux-LLM conventions: a dummy LLM
 * config (model "faux") plus an injected faux `chat` that returns canned
 * replies in call order.
 *
 * The faux replies model the real sequence: the planner emits a task JSON
 * array, each dispatched subagent returns findings, and the last call
 * synthesizes. Only the planner and synthesis calls are text-only; worker
 * calls are indistinguishable from them at this level, so replies are keyed by
 * call order.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeLlmConfig, type ChatFn } from "../src/llm/index.ts";
import type { AgentMessage, AssistantMessage } from "../src/types.ts";
import type { Tool, ToolProvider, ToolResult } from "../src/tools/types.ts";
import {
  buildSearchPlanPrompt,
  parseSearchPlan,
  resolveTaskModel,
  runSearchOrchestration,
} from "../src/orchestration/search-orchestrator.ts";
import { webResearcherProfile, defaultProfiles } from "../src/subagent/profiles.ts";
import { createSubagentTool } from "../src/subagent/index.ts";
import { createWebAccessTools } from "../src/web-access/index.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const dummyLlm = makeLlmConfig({
  apiKey: "test-key",
  baseUrl: "http://localhost/v1",
  model: "faux",
});

/** A tool that records every call, standing in for `web_search`. */
function createRecordingSearchTool(calls: string[]): Tool {
  return {
    name: "web_search",
    description: "Search the web.",
    parameters: { type: "object", properties: { query: { type: "string" } } },
    execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
      calls.push(String(args.query ?? ""));
      return { content: `result for ${args.query}` };
    },
  };
}

function planText(tasks: Array<Record<string, unknown>>): string {
  return "```json\n" + JSON.stringify(tasks, null, 2) + "\n```";
}

/** Answer the nth subagent call with the nth scripted reply (last repeats). */
function scriptedChat(replies: string[]): ChatFn {
  let call = 0;
  return async (): Promise<AssistantMessage> => {
    const reply = replies[Math.min(call, replies.length - 1)] ?? "";
    call += 1;
    return { role: "assistant", content: reply };
  };
}

/** Reply that depends on how many subagent calls have already happened. */
function chatByCall(fn: (call: number) => string): ChatFn {
  let call = 0;
  return async (): Promise<AssistantMessage> => {
    const reply = fn(call);
    call += 1;
    return { role: "assistant", content: reply };
  };
}

function makeOptions(overrides: Record<string, unknown> = {}) {
  return {
    query: "how do AI agents do web research",
    parentLlm: dummyLlm,
    parentTools: [] as ToolProvider,
    ...overrides,
  };
}

// ─── Plan prompt ─────────────────────────────────────────────────────────────

describe("buildSearchPlanPrompt", () => {
  it("embeds the question, task cap and available profiles", () => {
    const prompt = buildSearchPlanPrompt("compare sqlite and postgres", 4, ["researcher", "coder"]);
    assert.match(prompt, /compare sqlite and postgres/);
    assert.match(prompt, /at most 4 tasks/);
    assert.match(prompt, /researcher, coder/);
    assert.match(prompt, /web_search/);
  });

  it("appends round feedback when the previous plan was rejected", () => {
    const prompt = buildSearchPlanPrompt("q", 2, ["researcher"], "- unknown profile \"wizard\"");
    assert.match(prompt, /Previous round was rejected/);
    assert.match(prompt, /wizard/);
  });
});

// ─── Plan parsing / validation ───────────────────────────────────────────────

describe("parseSearchPlan", () => {
  const profiles = new Set(["researcher", "coder", "web-researcher"]);

  it("accepts a well-formed plan", () => {
    const outcome = parseSearchPlan(
      planText([
        { id: "t1", profile: "web-researcher", instruction: "gather facts" },
        { id: "t2", profile: "coder", instruction: "write sample", dependsOn: ["t1"], modelHint: "light" },
      ]),
      6,
      profiles,
    );
    assert.ok("tasks" in outcome);
    assert.equal(outcome.tasks.length, 2);
    assert.deepEqual(outcome.tasks[1]?.dependsOn, ["t1"]);
    assert.equal(outcome.tasks[1]?.modelHint, "light");
  });

  it("parses a bare (unfenced) JSON array", () => {
    const outcome = parseSearchPlan(
      'Here is the plan:\n[{"id":"t1","profile":"researcher","instruction":"do it"}]',
      6,
      profiles,
    );
    assert.ok("tasks" in outcome);
    assert.equal(outcome.tasks.length, 1);
  });

  it("rejects an unknown profile and names the alternatives", () => {
    const outcome = parseSearchPlan(
      planText([{ id: "t1", profile: "wizard", instruction: "do it" }]),
      6,
      profiles,
    );
    assert.ok("issues" in outcome);
    assert.match(outcome.issues.join("\n"), /unknown profile "wizard"/);
  });

  it("rejects a dependency on a task that does not exist", () => {
    const outcome = parseSearchPlan(
      planText([{ id: "t1", profile: "researcher", instruction: "do it", dependsOn: ["ghost"] }]),
      6,
      profiles,
    );
    assert.ok("issues" in outcome);
    assert.match(outcome.issues.join("\n"), /unknown task "ghost"/);
  });

  it("rejects a self-dependency and a cycle", () => {
    const self = parseSearchPlan(
      planText([{ id: "t1", profile: "researcher", instruction: "x", dependsOn: ["t1"] }]),
      6,
      profiles,
    );
    assert.ok("issues" in self);
    assert.match(self.issues.join("\n"), /depends on itself/);

    const cycle = parseSearchPlan(
      planText([
        { id: "a", profile: "researcher", instruction: "x", dependsOn: ["b"] },
        { id: "b", profile: "researcher", instruction: "y", dependsOn: ["a"] },
      ]),
      6,
      profiles,
    );
    assert.ok("issues" in cycle);
    assert.match(cycle.issues.join("\n"), /cycle/i);
  });

  it("rejects duplicate ids, missing instructions and oversized plans", () => {
    const duplicated = parseSearchPlan(
      planText([
        { id: "t1", profile: "researcher", instruction: "x" },
        { id: "t1", profile: "researcher", instruction: "y" },
      ]),
      6,
      profiles,
    );
    assert.ok("issues" in duplicated);
    assert.match(duplicated.issues.join("\n"), /duplicate task id "t1"/);

    const missing = parseSearchPlan(planText([{ id: "t1", profile: "researcher" }]), 6, profiles);
    assert.ok("issues" in missing);
    assert.match(missing.issues.join("\n"), /no instruction/);

    const tooMany = parseSearchPlan(
      planText(Array.from({ length: 3 }, (_, i) => ({ id: `t${i}`, profile: "researcher", instruction: "x" }))),
      2,
      profiles,
    );
    assert.ok("issues" in tooMany);
    assert.match(tooMany.issues.join("\n"), /at most 2 tasks, got 3/);
  });

  it("reports non-array output instead of throwing", () => {
    const outcome = parseSearchPlan("I could not produce a plan.", 6, profiles);
    assert.ok("issues" in outcome);
    assert.match(outcome.issues.join("\n"), /not a JSON array/);
  });
});

// ─── Model resolution ────────────────────────────────────────────────────────

describe("resolveTaskModel", () => {
  const models = [
    { id: "claude-sonnet-4-6", provider: "anthropic", name: "Claude Sonnet 4.6" },
    { id: "acme-reasoner-9", provider: "mythirdparty", name: "Acme Reasoner 9" },
  ];

  it("resolves a qualified provider/model reference", () => {
    assert.equal(resolveTaskModel("mythirdparty/acme-reasoner-9", models), "mythirdparty/acme-reasoner-9");
  });

  it("resolves by bare id and by fuzzy name", () => {
    assert.equal(resolveTaskModel("claude-sonnet-4-6", models), "anthropic/claude-sonnet-4-6");
    assert.equal(resolveTaskModel("Acme Reasoner 9", models), "mythirdparty/acme-reasoner-9");
  });

  it("returns undefined for an unknown reference", () => {
    assert.equal(resolveTaskModel("does-not-exist", models), undefined);
    assert.equal(resolveTaskModel(undefined, models), undefined);
  });
});

// ─── End-to-end workflow ─────────────────────────────────────────────────────

describe("runSearchOrchestration", () => {
  const plan = planText([
    { id: "t1", profile: "web-researcher", instruction: "gather facts", modelHint: "light" },
    { id: "t2", profile: "web-researcher", instruction: "check the claim", dependsOn: ["t1"] },
  ]);

  it("plans, dispatches and synthesizes", async () => {
    const chat = scriptedChat([plan, "FINDINGS-T1", "FINDINGS-T2", "SYNTHESIZED-ANSWER"]);
    const result = await runSearchOrchestration(makeOptions({ chat }));

    assert.equal(result.planRounds, 1);
    assert.deepEqual(result.tasks.map((t) => t.id), ["t1", "t2"]);
    assert.equal(result.results.length, 2);
    assert.ok(result.results.every((r) => r.status === "done"));
    assert.match(result.answer, /SYNTHESIZED-ANSWER/);
  });

  it("passes a dependency's output to the dependent task", async () => {
    const seen: string[] = [];
    const chat: ChatFn = async (_config, messages: AgentMessage[]): Promise<AssistantMessage> => {
      const text = messages
        .map((message) => (typeof message.content === "string" ? message.content : ""))
        .join("\n");
      const reply = seen.length === 0 ? plan : `worker-${seen.length}`;
      seen.push(text);
      return { role: "assistant", content: reply };
    };
    const result = await runSearchOrchestration(makeOptions({ chat }));
    assert.ok(result.tasks.length === 2);
    // The t2 call carries t1's findings in its shared context.
    assert.match(seen.join("\n"), /worker-1/);
  });

  it("applies modelMapping for a modelHint and reports the model", async () => {
    const chat = scriptedChat([plan, "a", "b", "merged"]);
    const result = await runSearchOrchestration(makeOptions({
      chat,
      modelMapping: { light: "mythirdparty/acme-reasoner-9" },
    }));
    const withHint = result.results.find((entry) => entry.id === "t1");
    assert.equal(withHint?.model, "mythirdparty/acme-reasoner-9");
  });

  it("resolves a task's explicit model against the supplied catalog", async () => {
    const explicit = planText([
      { id: "t1", profile: "web-researcher", instruction: "gather", model: "Acme Reasoner 9" },
    ]);
    const chat = scriptedChat([explicit, "findings", "merged"]);
    const result = await runSearchOrchestration(makeOptions({
      chat,
      models: [{ id: "acme-reasoner-9", provider: "mythirdparty", name: "Acme Reasoner 9" }],
    }));
    assert.equal(result.results[0]?.model, "mythirdparty/acme-reasoner-9");
  });

  it("does not forward an unresolvable model, and reports it", async () => {
    // An unresolved id would otherwise reach switchLlmModel and silently fall
    // back to the default OpenAI endpoint with an unrelated key.
    const explicit = planText([
      { id: "t1", profile: "web-researcher", instruction: "gather", model: "hallucinated-9" },
    ]);
    const chat = scriptedChat([explicit, "findings", "merged"]);
    const events: Array<{ type: string; model?: string; modelUnresolved?: string }> = [];
    const result = await runSearchOrchestration(makeOptions({
      chat,
      models: [{ id: "acme-reasoner-9", provider: "mythirdparty" }],
      onEvent: (event: { type: string }) => events.push(event as { type: string }),
    }));

    assert.equal(result.results[0]?.model, undefined, "no model should be forwarded");
    const dispatch = events.find((event) => event.type === "dispatch");
    assert.equal(dispatch?.modelUnresolved, "hallucinated-9");
    assert.equal(dispatch?.model, undefined);
  });

  it("resolves model hints only through the supplied mapping", async () => {
    const chat = scriptedChat([plan, "a", "b", "merged"]);
    const result = await runSearchOrchestration(makeOptions({
      chat,
      // No modelMapping supplied: the "light" hint must not invent a model.
    }));
    assert.ok(result.results.every((entry) => entry.model === undefined));
  });

  it("retries planning once and feeds back the validation issues", async () => {
    const bad = planText([{ id: "t1", profile: "wizard", instruction: "x" }]);
    const good = planText([{ id: "t1", profile: "web-researcher", instruction: "x" }]);
    const prompts: string[] = [];
    const chat: ChatFn = async (_config, messages: AgentMessage[]): Promise<AssistantMessage> => {
      const text = messages
        .map((message) => (typeof message.content === "string" ? message.content : ""))
        .join("\n");
      prompts.push(text);
      if (prompts.length === 1) return { role: "assistant", content: bad };
      if (prompts.length === 2) return { role: "assistant", content: good };
      return { role: "assistant", content: "final" };
    };
    const result = await runSearchOrchestration(makeOptions({ chat }));

    assert.equal(result.planRounds, 2);
    assert.deepEqual(result.tasks.map((t) => t.id), ["t1"]);
    // The rejection reason is echoed into the second planning prompt.
    assert.match(prompts[1] ?? "", /unknown profile "wizard"/);
  });

  it("returns no answer when planning never produces a valid plan", async () => {
    const chat = scriptedChat(["not a plan at all"]);
    const result = await runSearchOrchestration(makeOptions({ chat }));
    assert.equal(result.tasks.length, 0);
    assert.equal(result.answer, "");
    assert.equal(result.planRounds, 2);
  });

  it("honors planOnly by skipping dispatch", async () => {
    const chat = scriptedChat([plan, "should-not-be-called"]);
    const result = await runSearchOrchestration(makeOptions({ chat, planOnly: true }));
    assert.equal(result.tasks.length, 2);
    assert.equal(result.results.length, 0);
    assert.equal(result.answer, "");
  });

  it("keeps other tasks running when one fails", async () => {
    const parallel = planText([
      { id: "ok", profile: "web-researcher", instruction: "fine" },
      { id: "bad", profile: "web-researcher", instruction: "boom" },
    ]);
    // A subagent call fails when its output is an error; simulate by having the
    // chat throw for the "bad" task.
    let call = 0;
    const chat: ChatFn = async (_config, messages: AgentMessage[]): Promise<AssistantMessage> => {
      call += 1;
      if (call === 1) return { role: "assistant", content: parallel };
      const text = messages
        .map((message) => (typeof message.content === "string" ? message.content : ""))
        .join("\n");
      if (text.includes("boom")) throw new Error("subagent exploded");
      return { role: "assistant", content: call === 4 ? "merged" : "fine-output" };
    };
    const result = await runSearchOrchestration(makeOptions({ chat }));

    const ok = result.results.find((entry) => entry.id === "ok");
    const bad = result.results.find((entry) => entry.id === "bad");
    assert.equal(ok?.status, "done");
    assert.equal(bad?.status, "failed");
    assert.match(bad?.error ?? "", /exploded/);
  });

  it("emits plan, dispatch, done and synthesize events", async () => {
    const events: string[] = [];
    const chat = scriptedChat([plan, "a", "b", "merged"]);
    await runSearchOrchestration(makeOptions({
      chat,
      onEvent: (event: { type: string; id?: string }) => {
        events.push(event.id ? `${event.type}:${event.id}` : event.type);
      },
    }));
    assert.ok(events.includes("plan"));
    assert.ok(events.includes("dispatch:t1"));
    assert.ok(events.includes("done:t1"));
    assert.ok(events.includes("synthesize"));
  });

  it("runs tasks in dependency order", async () => {
    const order: string[] = [];
    const chat: ChatFn = async (_config, messages: AgentMessage[]): Promise<AssistantMessage> => {
      const text = messages
        .map((message) => (typeof message.content === "string" ? message.content : ""))
        .join("\n");
      if (order.length === 0) {
        order.push("plan");
        return { role: "assistant", content: plan };
      }
      if (text.includes("gather facts")) order.push("t1");
      else if (text.includes("check the claim")) order.push("t2");
      else order.push("synthesize");
      return { role: "assistant", content: "out" };
    };
    await runSearchOrchestration(makeOptions({ chat }));
    assert.deepEqual(order, ["plan", "t1", "t2", "synthesize"]);
  });
});

// ─── Profile wiring ──────────────────────────────────────────────────────────

describe("web-researcher profile", () => {
  it("can search the web", () => {
    assert.ok(webResearcherProfile.allowedTools?.includes("web_search"));
    assert.ok(webResearcherProfile.allowedTools?.includes("fetch_content"));
  });

  it("grants no write or command tools", () => {
    const tools = webResearcherProfile.allowedTools ?? [];
    for (const forbidden of ["bash", "write", "edit", "patch", "document_edit"]) {
      assert.ok(!tools.includes(forbidden), `must not grant ${forbidden}`);
    }
  });

  it("is not marked readOnly, which would strip its web tools", () => {
    // `readOnly` in the subagent gate means "no network / no external data",
    // so it would remove exactly the tools this profile needs. The allowlist
    // is the boundary instead.
    assert.notEqual(webResearcherProfile.readOnly, true);
  });

  it("is part of the default profile set", () => {
    assert.ok(defaultProfiles.some((profile) => profile.name === "web-researcher"));
  });

  it("leaves the plain researcher profile offline", () => {
    const researcher = defaultProfiles.find((profile) => profile.name === "researcher");
    assert.ok(!researcher?.allowedTools?.includes("web_search"));
    assert.equal(researcher?.readOnly, true);
  });
});

// ─── Tool reachability (regression guard) ────────────────────────────────────

describe("web-researcher tool reachability", () => {
  /**
   * Regression guard: `readOnly: true` means "no network" in the subagent tool
   * gate, so a readOnly web profile silently received NO web tools. Assert the
   * tools actually reach the child loop.
   */
  it("grants web_search to the subagent's tool set", async () => {
    const webTools = createWebAccessTools(process.cwd());
    const granted: string[][] = [];
    let call = 0;
    const chat: ChatFn = async (
      _config: unknown,
      _messages: AgentMessage[],
      tools?: Tool[],
    ): Promise<AssistantMessage> => {
      call += 1;
      granted.push((tools ?? []).map((tool) => tool.name));
      if (call === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "web_search", arguments: { query: "q" } }],
        };
      }
      return { role: "assistant", content: "findings with https://example.com" };
    };

    const tool = createSubagentTool({
      parentLlm: dummyLlm,
      parentTools: webTools,
      profiles: defaultProfiles,
      chat: chat as ChatFn,
    });
    const result = await tool.execute({ profile: "web-researcher", task: "research this" });

    assert.notEqual(result.isError, true);
    assert.ok(granted.length > 0, "the subagent loop should have run");
    assert.ok(
      granted[0]?.includes("web_search"),
      `web_search must reach the subagent; got ${granted[0]?.join(", ")}`,
    );
    assert.ok(granted[0]?.includes("fetch_content"));
  });

  it("keeps write and command tools away from the web subagent", async () => {
    const parentTools: Tool[] = [
      ...createWebAccessTools(process.cwd()),
      {
        name: "bash",
        description: "run a command",
        parameters: { type: "object", properties: { command: { type: "string" } } },
        execute: async (): Promise<ToolResult> => ({ content: "ok" }),
      } as Tool,
      {
        name: "write",
        description: "write a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        execute: async (): Promise<ToolResult> => ({ content: "ok" }),
      } as Tool,
    ];

    const granted: string[][] = [];
    let call = 0;
    const chat: ChatFn = async (
      _config: unknown,
      _messages: AgentMessage[],
      tools?: Tool[],
    ): Promise<AssistantMessage> => {
      call += 1;
      granted.push((tools ?? []).map((tool) => tool.name));
      return { role: "assistant", content: "done" };
    };

    const tool = createSubagentTool({
      parentLlm: dummyLlm,
      parentTools,
      profiles: defaultProfiles,
      chat: chat as ChatFn,
    });
    await tool.execute({ profile: "web-researcher", task: "research this" });

    const names = granted[0] ?? [];
    assert.ok(!names.includes("bash"), "bash must not be granted");
    assert.ok(!names.includes("write"), "write must not be granted");
    assert.ok(names.includes("web_search"), "web_search must still be granted");
  });
});