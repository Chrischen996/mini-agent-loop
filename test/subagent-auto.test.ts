import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideAutoSubagent,
  loadAutoSubagentOptionsFromEnv,
} from "../src/subagent/index.ts";
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

function fakeReadTool(execute: Tool["execute"] = async () => ({ content: "file" })): Tool {
  return {
    name: "read",
    description: "read a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
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
    assert.equal(decision.coordinatorMode, true);
    assert.ok(decision.score >= 3);
    assert.ok(decision.reasons.includes("code/workspace context"));
    assert.equal(decideAutoSubagent("hello", { minScore: 3 }).shouldDelegate, false);
    assert.equal(decideAutoSubagent("请委托给 subagent", { minScore: 3 }).shouldDelegate, true);
  });

  it("infers coder/reviewer/researcher profiles from the prompt", () => {
    assert.equal(
      decideAutoSubagent("请修改项目代码并实现一个新模块", { minScore: 3 }).profile,
      "researcher",
    );
    assert.equal(
      decideAutoSubagent("请修改项目代码并实现一个新模块", { minScore: 3, allowWrites: true }).profile,
      "coder",
    );
    assert.equal(
      decideAutoSubagent("请审查这个项目的主模块并给出代码审查意见", { minScore: 3 }).profile,
      "reviewer",
    );
    assert.equal(
      decideAutoSubagent("请分析这个仓库的架构结构", { minScore: 3 }).profile,
      "researcher",
    );
  });

  it("does not delegate simple single-step tasks", () => {
    const decision = decideAutoSubagent("读一下 package.json");
    assert.equal(decision.shouldDelegate, false);
    assert.equal(decision.coordinatorMode, false);
  });

  it("loads enabled-by-default options from env and supports opt-out", () => {
    const previous = {
      auto: process.env.MINI_AGENT_AUTO_SUBAGENT,
      profile: process.env.MINI_AGENT_AUTO_SUBAGENT_PROFILE,
      minScore: process.env.MINI_AGENT_AUTO_SUBAGENT_MIN_SCORE,
      coordinator: process.env.MINI_AGENT_COORDINATOR_MODE,
      explore: process.env.MINI_AGENT_MAX_DIRECT_EXPLORATION,
      allowWrites: process.env.MINI_AGENT_AUTO_SUBAGENT_ALLOW_WRITES,
    };
    try {
      delete process.env.MINI_AGENT_AUTO_SUBAGENT;
      delete process.env.MINI_AGENT_AUTO_SUBAGENT_PROFILE;
      delete process.env.MINI_AGENT_AUTO_SUBAGENT_MIN_SCORE;
      delete process.env.MINI_AGENT_COORDINATOR_MODE;
      delete process.env.MINI_AGENT_MAX_DIRECT_EXPLORATION;
      delete process.env.MINI_AGENT_AUTO_SUBAGENT_ALLOW_WRITES;
      assert.deepEqual(loadAutoSubagentOptionsFromEnv(), { enabled: true });

      process.env.MINI_AGENT_AUTO_SUBAGENT = "0";
      assert.equal(loadAutoSubagentOptionsFromEnv(), undefined);

      process.env.MINI_AGENT_AUTO_SUBAGENT = "false";
      assert.equal(loadAutoSubagentOptionsFromEnv(), undefined);

      process.env.MINI_AGENT_AUTO_SUBAGENT = "1";
      process.env.MINI_AGENT_AUTO_SUBAGENT_PROFILE = "coder";
      process.env.MINI_AGENT_AUTO_SUBAGENT_MIN_SCORE = "4";
      process.env.MINI_AGENT_COORDINATOR_MODE = "0";
      process.env.MINI_AGENT_MAX_DIRECT_EXPLORATION = "1";
      process.env.MINI_AGENT_AUTO_SUBAGENT_ALLOW_WRITES = "1";
      assert.deepEqual(loadAutoSubagentOptionsFromEnv(), {
        enabled: true,
        profile: "coder",
        minScore: 4,
        coordinatorMode: false,
        maxDirectExploration: 1,
        allowWrites: true,
      });
    } finally {
      for (const [key, value] of Object.entries({
        MINI_AGENT_AUTO_SUBAGENT: previous.auto,
        MINI_AGENT_AUTO_SUBAGENT_PROFILE: previous.profile,
        MINI_AGENT_AUTO_SUBAGENT_MIN_SCORE: previous.minScore,
        MINI_AGENT_COORDINATOR_MODE: previous.coordinator,
        MINI_AGENT_MAX_DIRECT_EXPLORATION: previous.explore,
        MINI_AGENT_AUTO_SUBAGENT_ALLOW_WRITES: previous.allowWrites,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
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
    const calls: Array<Record<string, unknown>> = [];
    const tool = fakeSubagentTool(async (args) => {
      calls.push(args as Record<string, unknown>);
      return { content: "research result" };
    });
    let parentCalls = 0;
    const events: LoopEvent[] = [];
    const prompt =
      "Please analyze the repository code and compare the relevant modules in multiple steps.";
    const messages = await runAgentLoop(prompt, {
      llm,
      tools: [tool],
      autoSubagent: { enabled: true, minScore: 3 },
      chat: async (_config, context) => {
        parentCalls += 1;
        assert.equal(context.at(-1)?.role, "tool");
        const system = context.find((message) => message.role === "system");
        assert.ok(typeof system?.content === "string" && system.content.includes("### Coordinator Mode"));
        return { role: "assistant", content: "parent used research" };
      },
      onEvent: (event) => events.push(event),
    });

    assert.equal(parentCalls, 1);
    assert.equal(calls.length, 1);
    // Preflight should pass a focused task, not the raw user prompt alone.
    assert.notEqual(calls[0]?.task, prompt);
    assert.match(String(calls[0]?.task), /researcher subagent/i);
    assert.match(String(calls[0]?.task), /User request:/);
    assert.match(String(calls[0]?.task), /compare the relevant modules/);
    assert.equal(calls[0]?.profile, "researcher");
    assert.deepEqual(messages.map((message) => message.role), ["system", "user", "assistant", "tool", "assistant"]);
    assert.ok(events.some((event) => event.type === "tool_start" && event.call.name === "subagent"));
    assert.ok(events.some((event) => event.type === "tool_end" && event.call.name === "subagent"));
    const autoEvents = events.filter((event) => event.type === "auto_subagent");
    assert.ok(autoEvents.length >= 2);
    assert.equal(autoEvents[0]?.shouldDelegate, true);
    assert.equal(autoEvents[0]?.executed, false);
    assert.equal(autoEvents[0]?.coordinatorMode, true);
    assert.equal(autoEvents.at(-1)?.executed, true);
    assert.equal(autoEvents.at(-1)?.profile, "researcher");
    assert.ok(events.some((event) => event.type === "coordinator_mode" && event.active));
  });

  it("downgrades automatic implementation preflight to the read-only researcher", async () => {
    let receivedArgs: Record<string, unknown> | undefined;
    const tool = fakeSubagentTool(async (args) => {
      receivedArgs = args as Record<string, unknown>;
      return { content: "coder result" };
    });
    await runAgentLoop("请修改项目代码并实现一个新模块，然后补充测试", {
      llm,
      tools: [tool],
      autoSubagent: { enabled: true, minScore: 3 },
      chat: async () => ({ role: "assistant", content: "parent answer" }),
    });

    assert.equal(receivedArgs?.profile, "researcher");
  });

  it("selects the coder profile only with explicit write opt-in", async () => {
    let receivedArgs: Record<string, unknown> | undefined;
    const tool = fakeSubagentTool(async (args) => {
      receivedArgs = args as Record<string, unknown>;
      return { content: "coder result" };
    });
    await runAgentLoop("请修改项目代码并实现一个新模块，然后补充测试", {
      llm,
      tools: [tool],
      autoSubagent: { enabled: true, minScore: 3, allowWrites: true },
      chat: async () => ({ role: "assistant", content: "parent answer" }),
    });

    assert.equal(receivedArgs?.profile, "coder");
  });

  it("blocks excess direct exploration while coordinator mode is active", async () => {
    let readCalls = 0;
    const read = fakeReadTool(async () => {
      readCalls += 1;
      return { content: `file-${readCalls}` };
    });
    const subagent = fakeSubagentTool(async () => ({ content: "preflight research" }));
    let parentTurn = 0;
    const events: LoopEvent[] = [];
    const messages = await runAgentLoop(
      "Please analyze the repository code and compare the relevant modules in multiple steps.",
      {
        llm,
        tools: [subagent, read],
        autoSubagent: { enabled: true, minScore: 3, maxDirectExploration: 1 },
        chat: async () => {
          parentTurn += 1;
          if (parentTurn === 1) {
            return {
              role: "assistant",
              content: "",
              toolCalls: [
                { id: "r1", name: "read", arguments: { path: "a.ts" } },
                { id: "r2", name: "read", arguments: { path: "b.ts" } },
              ],
            };
          }
          return { role: "assistant", content: "done after budget check" };
        },
        onEvent: (event) => events.push(event),
      },
    );

    // First read is allowed, second is blocked by coordinator budget.
    assert.equal(readCalls, 1);
    const toolResults = messages.filter(
      (message): message is Extract<(typeof messages)[number], { role: "tool" }> =>
        message.role === "tool" && message.name === "read",
    );
    assert.equal(toolResults.length, 2);
    assert.equal(toolResults[0]?.isError, undefined);
    assert.equal(toolResults[1]?.isError, true);
    assert.match(String(toolResults[1]?.content), /Coordinator mode blocked direct exploration/);
    assert.ok(
      events.some(
        (event) =>
          event.type === "coordinator_mode" &&
          event.active &&
          event.directExplorationUsed >= 1,
      ),
    );
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
    assert.match(String(receivedArgs?.task), /User request:/);
    assert.match(String(receivedArgs?.task), /compare the relevant modules/);
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
    const events: LoopEvent[] = [];
    const messages = await runAgentLoop(
      "Please analyze the repository code and compare the relevant modules in multiple steps.",
      {
        llm,
        tools: [],
        autoSubagent: { enabled: true, minScore: 3 },
        chat: async (_config, context) => {
          parentCalls += 1;
          const system = context.find((message) => message.role === "system");
          assert.ok(typeof system?.content === "string" && system.content.includes("### Coordinator Mode"));
          return { role: "assistant", content: "normal answer" };
        },
        onEvent: (event) => events.push(event),
      },
    );

    assert.equal(parentCalls, 1);
    assert.deepEqual(messages.map((message) => message.role), ["system", "user", "assistant"]);
    const autoEvent = events.find((event) => event.type === "auto_subagent");
    assert.ok(autoEvent);
    assert.equal(autoEvent?.shouldDelegate, true);
    assert.equal(autoEvent?.executed, false);
    assert.equal(autoEvent?.coordinatorMode, true);
    assert.ok(events.some((event) => event.type === "coordinator_mode" && event.active));
  });
});
