import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideAutoSubagent } from "../src/subagent/index.ts";
import { runAgentLoop } from "../src/loop.ts";
import { makeLlmConfig } from "../src/llm/index.ts";
import type { Tool } from "../src/tools/types.ts";
import type { LoopEvent } from "../src/loop.ts";

const llm = makeLlmConfig({
  apiKey: "test-key",
  baseUrl: "http://localhost/v1",
  model: "faux",
});

function fakeSubagentTool(execute: Tool["execute"], includeProfile = true): Tool {
  return {
    name: "subagent",
    description: "test subagent",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string" },
        ...(includeProfile ? { profile: { type: "string" } } : {}),
      },
      required: ["task"],
    },
    execute,
  };
}

describe("automatic subagent preflight", () => {
  it("uses explainable signals and respects the score threshold", () => {
    const decision = decideAutoSubagent(
      "Please analyze the repository code and compare the relevant modules in multiple steps.",
      { minScore: 3, profile: "researcher" },
    );
    assert.equal(decision.shouldDelegate, true);
    assert.ok(decision.score >= 3);
    assert.ok(decision.reasons.includes("code/workspace context"));
    assert.equal(decideAutoSubagent("hello", { minScore: 3 }).shouldDelegate, false);
    assert.equal(decideAutoSubagent("请委托给 subagent", { minScore: 3 }).shouldDelegate, true);
  });

  it("does not preflight when the option is omitted", async () => {
    let subagentCalls = 0;
    const tool = fakeSubagentTool(async () => {
      subagentCalls += 1;
      return { content: "unexpected" };
    });
    const messages = await runAgentLoop("analyze this code", {
      llm,
      tools: [tool],
      chat: async () => ({ role: "assistant", content: "parent answer" }),
    });

    assert.equal(subagentCalls, 0);
    assert.deepEqual(messages.map((message) => message.role), ["system", "user", "assistant"]);
  });

  it("runs one automatic subagent call before the parent model", async () => {
    const calls: string[] = [];
    const tool = fakeSubagentTool(async (args) => {
      calls.push(String((args as { task: string }).task));
      return { content: "research result" };
    });
    let parentCalls = 0;
    const events: LoopEvent[] = [];
    const messages = await runAgentLoop(
      "Please analyze the repository code and compare the relevant modules in multiple steps.",
      {
        llm,
        tools: [tool],
        autoSubagent: { enabled: true, minScore: 3, profile: "researcher" },
        chat: async (_config, context) => {
          parentCalls += 1;
          assert.equal(context.at(-1)?.role, "tool");
          return { role: "assistant", content: "parent used research" };
        },
        onEvent: (event) => events.push(event),
      },
    );

    assert.equal(parentCalls, 1);
    assert.deepEqual(calls, ["Please analyze the repository code and compare the relevant modules in multiple steps."]);
    assert.deepEqual(messages.map((message) => message.role), ["system", "user", "assistant", "tool", "assistant"]);
    assert.ok(events.some((event) => event.type === "tool_start" && event.call.name === "subagent"));
    assert.ok(events.some((event) => event.type === "tool_end" && event.call.name === "subagent"));
  });

  it("does not pass a profile to a custom profile-less subagent tool", async () => {
    let receivedArgs: Record<string, unknown> | undefined;
    const tool = fakeSubagentTool(async (args) => {
      receivedArgs = args;
      return { content: "profile-less result" };
    }, false);
    await runAgentLoop(
      "Please analyze the repository code and compare the relevant modules in multiple steps.",
      {
        llm,
        tools: [tool],
        autoSubagent: { enabled: true, minScore: 3 },
        chat: async () => ({ role: "assistant", content: "parent answer" }),
      },
    );

    assert.equal(receivedArgs?.profile, undefined);
    assert.equal(receivedArgs?.task, "Please analyze the repository code and compare the relevant modules in multiple steps.");
  });

  it("does not call the parent model after the automatic call is aborted", async () => {
    const controller = new AbortController();
    let parentCalls = 0;
    const tool = fakeSubagentTool(async () => {
      controller.abort();
      return { content: "stopped", isError: true };
    });
    const messages = await runAgentLoop(
      "Please analyze the repository code and compare the relevant modules in multiple steps.",
      {
        llm,
        tools: [tool],
        autoSubagent: { enabled: true, minScore: 3 },
        signal: controller.signal,
        chat: async () => {
          parentCalls += 1;
          return { role: "assistant", content: "must not run" };
        },
      },
    );

    assert.equal(parentCalls, 0);
    assert.equal(messages.at(-1)?.role, "tool");
  });

  it("does not trigger when the subagent tool is unavailable", async () => {
    let parentCalls = 0;
    const messages = await runAgentLoop(
      "Please analyze the repository code and compare the relevant modules in multiple steps.",
      {
        llm,
        tools: [],
        autoSubagent: { enabled: true, minScore: 3 },
        chat: async () => {
          parentCalls += 1;
          return { role: "assistant", content: "normal answer" };
        },
      },
    );

    assert.equal(parentCalls, 1);
    assert.deepEqual(messages.map((message) => message.role), ["system", "user", "assistant"]);
  });
});
