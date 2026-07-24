import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSubagentTool } from "../src/subagent/index.ts";
import type {
  SubagentEvent,
  SubagentProfile,
} from "../src/subagent/types.ts";
import { contentAsString } from "../src/content.ts";
import { makeLlmConfig, type ChatFn } from "../src/llm/index.ts";
import type { Tool, ToolResult } from "../src/tools/types.ts";
import type { AssistantMessage } from "../src/types.ts";

// ─── Shared helpers ──────────────────────────────────────────────────────────

const dummyLlm = makeLlmConfig({
  apiKey: "test-key",
  baseUrl: "http://localhost/v1",
  model: "faux",
});

/** A minimal tool for child agents to call. */
function createEchoTool(): Tool {
  return {
    name: "echo",
    description: "echoes back the input",
    parameters: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
    execute: async (args: Record<string, unknown>): Promise<ToolResult> => ({
      content: `echo: ${args.message}`,
    }),
  };
}

/** A tool that records when it was called. */
function createTrackerTool(callLog: string[]): Tool {
  return {
    name: "tracker",
    description: "records calls",
    parameters: {
      type: "object",
      properties: { label: { type: "string" } },
    },
    execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
      callLog.push(String(args.label ?? "unlabeled"));
      return { content: `tracked: ${args.label}` };
    },
  };
}

/**
 * Create a faux chat that immediately answers with the given text.
 * No tool calls — the sub-agent completes in one turn.
 */
function createImmediateChat(text: string): ChatFn {
  return async (): Promise<AssistantMessage> => ({
    role: "assistant",
    content: text,
  });
}

/**
 * Create a faux chat that calls a tool first, then answers.
 * Turn 1: tool call → Turn 2: final answer.
 */
function createToolThenAnswerChat(
  toolName: string,
  toolArgs: Record<string, unknown>,
  finalText: string,
): ChatFn {
  let callCount = 0;
  return async (): Promise<AssistantMessage> => {
    callCount += 1;
    if (callCount === 1) {
      return {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: `sub_call_${callCount}`, name: toolName, arguments: toolArgs },
        ],
      };
    }
    return { role: "assistant", content: finalText };
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────
// Wrapped in a single parent `describe` to ensure serial execution on Node 18,
// which runs top-level describe blocks concurrently by default.

describe("createSubagentTool", () => {

  // ── Tool metadata ──────────────────────────────────────────────────────────

  describe("tool metadata", () => {
    it("has the correct name, description, and required parameters", () => {
      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [],
        chat: createImmediateChat("ok"),
      });

      const params = tool.parameters as Record<string, any>;
      assert.equal(tool.name, "subagent");
      assert.equal(tool.displayName, "Sub-Agent");
      assert.ok(tool.description.includes("sub-agent"));
      assert.deepEqual(params.required, ["task"]);
      assert.ok(params.properties.task);
      assert.ok(params.properties.systemPrompt);
      assert.ok(params.properties.tools);
      assert.ok(params.properties.maxTurns);
    });

    it("includes profile enum when profiles are provided", () => {
      const profiles: SubagentProfile[] = [
        { name: "researcher", description: "research stuff", systemPrompt: "research" },
        { name: "coder", description: "write code", systemPrompt: "code" },
      ];

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [],
        profiles,
        chat: createImmediateChat("ok"),
      });

      const params = tool.parameters as Record<string, any>;
      assert.ok(params.properties.profile, "profile property should exist");
      assert.deepEqual(params.properties.profile.enum, ["researcher", "coder"]);
      assert.ok(tool.description.includes("researcher"));
      assert.ok(tool.description.includes("coder"));
    });

    it("omits profile property when no profiles are configured", () => {
      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [],
        chat: createImmediateChat("ok"),
      });

      const params = tool.parameters as Record<string, any>;
      assert.equal(params.properties.profile, undefined);
      assert.ok(tool.description.includes("No pre-defined profiles"));
    });
  });

  // ── Basic execution ────────────────────────────────────────────────────────

  describe("basic execution", () => {
    it("returns the sub-agent final answer as tool result", async () => {
      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [],
        chat: createImmediateChat("The answer is 42."),
      });

      const result = await tool.execute({ task: "What is the answer?" });
      assert.equal(result.isError, undefined);
      assert.equal(contentAsString(result.content), "The answer is 42.");
    });

    it("sub-agent can use tools from the parent and return a result", async () => {
      const echo = createEchoTool();
      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [echo],
        chat: createToolThenAnswerChat("echo", { message: "hello" }, "Echo test complete."),
      });

      const result = await tool.execute({ task: "echo hello" });
      assert.equal(result.isError, undefined);
      assert.equal(contentAsString(result.content), "Echo test complete.");
    });

    it("returns isError when sub-agent produces no usable answer", async () => {
      // Empty content causes the loop to retry and eventually throw;
      // the subagent catches the error and returns isError.
      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [],
        chat: createImmediateChat(""),
      });

      const result = await tool.execute({ task: "do nothing" });
      assert.equal(result.isError, true);
      const text = contentAsString(result.content);
      assert.ok(
        text.includes("Sub-agent failed") || text.includes("no final answer"),
        `Expected error about empty answer, got: ${text.slice(0, 120)}`,
      );
    });
  });

  // ── Depth limiting ─────────────────────────────────────────────────────────

  describe("depth limiting", () => {
    it("returns isError when maxDepth is reached", async () => {
      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [],
        maxDepth: 2,
        currentDepth: 2,
        chat: createImmediateChat("should not run"),
      });

      const result = await tool.execute({ task: "too deep" });
      assert.equal(result.isError, true);
      assert.ok(contentAsString(result.content).includes("depth limit"));
      assert.ok(contentAsString(result.content).includes("max 2"));
    });

    it("runs successfully when depth is below maxDepth", async () => {
      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [],
        maxDepth: 3,
        currentDepth: 1,
        chat: createImmediateChat("depth ok"),
      });

      const result = await tool.execute({ task: "within depth" });
      assert.equal(result.isError, undefined);
      assert.equal(contentAsString(result.content), "depth ok");
    });

    it("does not add nested subagent tool when child depth equals maxDepth", async () => {
      // At currentDepth=2 with maxDepth=3: the child is depth 3 == maxDepth,
      // so no further subagent tool should be added to the child.
      const toolNames: string[] = [];
      const chatSpy: ChatFn = async (_config, _messages, tools) => {
        if (tools) toolNames.push(...tools.map((t: Tool) => t.name));
        return { role: "assistant", content: "leaf" };
      };

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [createEchoTool()],
        maxDepth: 3,
        currentDepth: 2,
        chat: chatSpy,
      });

      await tool.execute({ task: "check tools" });
      assert.ok(!toolNames.includes("subagent"), `Expected no subagent tool, got: [${toolNames}]`);
      assert.ok(toolNames.includes("echo"));
    });

    it("adds nested subagent tool when child depth is below maxDepth", async () => {
      const toolNames: string[] = [];
      const chatSpy: ChatFn = async (_config, _messages, tools) => {
        if (tools) toolNames.push(...tools.map((t: Tool) => t.name));
        return { role: "assistant", content: "mid" };
      };

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [createEchoTool()],
        maxDepth: 3,
        currentDepth: 0,
        chat: chatSpy,
      });

      await tool.execute({ task: "check nested" });
      assert.ok(toolNames.includes("subagent"), `Expected subagent tool, got: [${toolNames}]`);
      assert.ok(toolNames.includes("echo"));
    });
  });

  // ── Profile resolution ─────────────────────────────────────────────────────

  describe("profile resolution", () => {
    const profiles: SubagentProfile[] = [
      {
        name: "researcher",
        description: "reads files",
        systemPrompt: "You are a researcher.",
        allowedTools: ["echo"],
        maxTurns: 8,
      },
      {
        name: "coder",
        description: "writes code",
        systemPrompt: "You are a coder.",
        allowedTools: ["tracker"],
        maxTurns: 10,
      },
    ];

    it("uses profile system prompt when profile is specified", async () => {
      let capturedMessages: import("../src/types.ts").AgentMessage[] = [];
      const chatSpy: ChatFn = async (_config, messages) => {
        capturedMessages = messages;
        return { role: "assistant", content: "profiled" };
      };

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [createEchoTool()],
        profiles,
        chat: chatSpy,
      });

      await tool.execute({ task: "research", profile: "researcher" });
      const systemMsg = capturedMessages.find((m) => m.role === "system");
      assert.ok(systemMsg);
      assert.ok(contentAsString(systemMsg.content).includes("You are a researcher."));
    });

    it("uses ad-hoc system prompt when no profile is specified", async () => {
      let capturedMessages: import("../src/types.ts").AgentMessage[] = [];
      const chatSpy: ChatFn = async (_config, messages) => {
        capturedMessages = messages;
        return { role: "assistant", content: "ad-hoc" };
      };

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [createEchoTool()],
        profiles,
        chat: chatSpy,
      });

      await tool.execute({ task: "custom task", systemPrompt: "Custom system." });
      const systemMsg = capturedMessages.find((m) => m.role === "system");
      assert.ok(systemMsg);
      assert.ok(contentAsString(systemMsg.content).includes("Custom system."));
    });

    it("uses default system prompt when neither profile nor ad-hoc is given", async () => {
      let capturedMessages: import("../src/types.ts").AgentMessage[] = [];
      const chatSpy: ChatFn = async (_config, messages) => {
        capturedMessages = messages;
        return { role: "assistant", content: "default" };
      };

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [createEchoTool()],
        chat: chatSpy,
      });

      await tool.execute({ task: "something" });
      const systemMsg = capturedMessages.find((m) => m.role === "system");
      assert.ok(systemMsg);
      assert.ok(contentAsString(systemMsg.content).includes("focused sub-agent"));
    });

    it("profile allowedTools filters the child tool set", async () => {
      const toolNames: string[] = [];
      const chatSpy: ChatFn = async (_config, _messages, tools) => {
        if (tools) toolNames.push(...tools.map((t: Tool) => t.name));
        return { role: "assistant", content: "filtered" };
      };

      const callLog: string[] = [];
      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [createEchoTool(), createTrackerTool(callLog)],
        profiles,
        chat: chatSpy,
      });

      // researcher profile only allows "echo"
      await tool.execute({ task: "filter", profile: "researcher" });
      assert.ok(toolNames.includes("echo"), `Should include echo, got: [${toolNames}]`);
      assert.ok(!toolNames.includes("tracker"), `Should NOT include tracker, got: [${toolNames}]`);
    });

    it("profile maxTurns overrides default", async () => {
      // Use an infinite-loop chat. The researcher profile has maxTurns=8;
      // the subagent should hit MaxTurnsExceededError, caught internally.
      let toolCalls = 0;
      const infiniteChat: ChatFn = async () => {
        toolCalls += 1;
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: `call_${toolCalls}`, name: "echo", arguments: { message: "loop" } },
          ],
        };
      };

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [createEchoTool()],
        profiles,
        chat: infiniteChat,
      });

      const result = await tool.execute({ task: "run", profile: "researcher" });
      assert.equal(result.isError, true);
      assert.ok(contentAsString(result.content).includes("Sub-agent failed"));
    });

    it("ad-hoc maxTurns overrides profile maxTurns", async () => {
      let toolCalls = 0;
      const infiniteChat: ChatFn = async () => {
        toolCalls += 1;
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: `call_${toolCalls}`, name: "echo", arguments: { message: "loop" } },
          ],
        };
      };

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [createEchoTool()],
        profiles,
        chat: infiniteChat,
      });

      // researcher profile has maxTurns=8, but we override with 2
      const result = await tool.execute({
        task: "run",
        profile: "researcher",
        maxTurns: 2,
      });
      assert.equal(result.isError, true);
      assert.ok(toolCalls <= 3, `Expected ≤3 chat calls with maxTurns=2, got ${toolCalls}`);
    });

    it("unknown profile falls back to default config", async () => {
      let capturedMessages: import("../src/types.ts").AgentMessage[] = [];
      const chatSpy: ChatFn = async (_config, messages) => {
        capturedMessages = messages;
        return { role: "assistant", content: "unknown profile" };
      };

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [createEchoTool()],
        profiles,
        chat: chatSpy,
      });

      await tool.execute({ task: "go", profile: "nonexistent" });
      const systemMsg = capturedMessages.find((m) => m.role === "system");
      assert.ok(systemMsg);
      assert.ok(contentAsString(systemMsg.content).includes("focused sub-agent"));
    });
  });

  // ── Tool filtering ─────────────────────────────────────────────────────────

  describe("tool filtering", () => {
    it("excludes the subagent tool from child tool set by default", async () => {
      const toolNames: string[] = [];
      const chatSpy: ChatFn = async (_config, _messages, tools) => {
        if (tools) toolNames.push(...tools.map((t: Tool) => t.name));
        return { role: "assistant", content: "filtered" };
      };

      const fakeSubagent: Tool = {
        name: "subagent",
        description: "fake subagent",
        parameters: { type: "object" },
        execute: async () => ({ content: "fake" }),
      };

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [createEchoTool(), fakeSubagent],
        maxDepth: 1,
        currentDepth: 0,
        chat: chatSpy,
      });

      await tool.execute({ task: "test" });
      assert.ok(!toolNames.includes("subagent"), `Should exclude subagent, got: [${toolNames}]`);
      assert.ok(toolNames.includes("echo"));
    });

    it("ad-hoc tools whitelist filters to the specified subset", async () => {
      const toolNames: string[] = [];
      const chatSpy: ChatFn = async (_config, _messages, tools) => {
        if (tools) toolNames.push(...tools.map((t: Tool) => t.name));
        return { role: "assistant", content: "subset" };
      };

      const callLog: string[] = [];
      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [createEchoTool(), createTrackerTool(callLog)],
        maxDepth: 1,
        currentDepth: 0,
        chat: chatSpy,
      });

      await tool.execute({ task: "filtered", tools: ["tracker"] });
      assert.ok(toolNames.includes("tracker"), `Should include tracker, got: [${toolNames}]`);
      assert.ok(!toolNames.includes("echo"), `Should NOT include echo, got: [${toolNames}]`);
    });

    it("inherits all parent tools (minus subagent) when no whitelist given", async () => {
      const toolNames: string[] = [];
      const chatSpy: ChatFn = async (_config, _messages, tools) => {
        if (tools) toolNames.push(...tools.map((t: Tool) => t.name));
        return { role: "assistant", content: "all" };
      };

      const callLog: string[] = [];
      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [createEchoTool(), createTrackerTool(callLog)],
        maxDepth: 1,
        currentDepth: 0,
        chat: chatSpy,
      });

      await tool.execute({ task: "inherit all" });
      assert.ok(toolNames.includes("echo"));
      assert.ok(toolNames.includes("tracker"));
    });
  });

  // ── Event propagation ──────────────────────────────────────────────────────

  describe("event propagation", () => {
    it("emits subagent_start and subagent_end events", async () => {
      const events: SubagentEvent[] = [];

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [],
        onSubagentEvent: (event) => events.push(event),
        chat: createImmediateChat("done"),
      });

      await tool.execute({ task: "event test" });

      const starts = events.filter((e) => e.type === "subagent_start");
      const ends = events.filter((e) => e.type === "subagent_end");
      assert.equal(starts.length, 1);
      assert.equal(ends.length, 1);

      const start = starts[0]!;
      if (start.type === "subagent_start") {
        assert.equal(start.task, "event test");
        assert.equal(start.depth, 1);
        assert.ok(start.id, "should have an id");
      }

      const end = ends[0]!;
      if (end.type === "subagent_end") {
        assert.equal(end.success, true);
        assert.equal(end.result, "done");
        assert.equal(end.depth, 1);
        assert.ok(end.turns >= 1);
      }
    });

    it("emits subagent_event for inner loop events", async () => {
      const events: SubagentEvent[] = [];

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [createEchoTool()],
        onSubagentEvent: (event) => events.push(event),
        chat: createToolThenAnswerChat("echo", { message: "hi" }, "done"),
      });

      await tool.execute({ task: "inner events" });

      const innerEvents = events.filter((e) => e.type === "subagent_event");
      assert.ok(innerEvents.length > 0, "should have inner events");

      // Should include tool_start and tool_end events for the echo call
      const toolEvents = innerEvents.filter(
        (e) =>
          e.type === "subagent_event" &&
          (e.inner.type === "tool_start" || e.inner.type === "tool_end"),
      );
      assert.ok(toolEvents.length >= 2, `Expected tool events, got ${toolEvents.length}`);
    });

    it("start and end events share the same invocation id", async () => {
      const events: SubagentEvent[] = [];

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [],
        onSubagentEvent: (event) => events.push(event),
        chat: createImmediateChat("ok"),
      });

      await tool.execute({ task: "id check" });

      const start = events.find((e) => e.type === "subagent_start")!;
      const end = events.find((e) => e.type === "subagent_end")!;
      assert.ok(start && end);
      assert.equal(start.id, end.id);
    });

    it("event order is: start → inner events → end", async () => {
      const eventTypes: string[] = [];

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [createEchoTool()],
        onSubagentEvent: (event) => eventTypes.push(event.type),
        chat: createToolThenAnswerChat("echo", { message: "x" }, "done"),
      });

      await tool.execute({ task: "order check" });

      assert.equal(eventTypes[0], "subagent_start");
      assert.equal(eventTypes[eventTypes.length - 1], "subagent_end");
      for (let i = 1; i < eventTypes.length - 1; i++) {
        assert.equal(eventTypes[i], "subagent_event");
      }
    });

    it("includes profile name in start event when profile is used", async () => {
      const events: SubagentEvent[] = [];
      const profiles: SubagentProfile[] = [
        { name: "researcher", description: "reads", systemPrompt: "research" },
      ];

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [],
        profiles,
        onSubagentEvent: (event) => events.push(event),
        chat: createImmediateChat("ok"),
      });

      await tool.execute({ task: "with profile", profile: "researcher" });

      const start = events.find((e) => e.type === "subagent_start");
      assert.ok(start && start.type === "subagent_start");
      if (start?.type === "subagent_start") {
        assert.equal(start.profile, "researcher");
      }
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  describe("error handling", () => {
    it("returns isError when the inner loop throws", async () => {
      const events: SubagentEvent[] = [];

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [],
        onSubagentEvent: (event) => events.push(event),
        chat: async () => { throw new Error("simulated API failure"); },
      });

      const result = await tool.execute({ task: "fail" });
      assert.equal(result.isError, true);
      assert.ok(contentAsString(result.content).includes("Sub-agent failed"));
      assert.ok(contentAsString(result.content).includes("simulated API failure"));

      const end = events.find((e) => e.type === "subagent_end");
      assert.ok(end && end.type === "subagent_end");
      if (end?.type === "subagent_end") {
        assert.equal(end.success, false);
        assert.equal(end.result, "");
        assert.equal(end.turns, 0);
        assert.equal(typeof end.totalTokens, "number");
      }
    });

    it("does not throw — error is contained in ToolResult", async () => {
      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [],
        chat: async () => { throw new Error("boom"); },
      });

      // Should NOT throw
      const result = await tool.execute({ task: "boom" });
      assert.equal(result.isError, true);
    });
  });

  // ── Abort signal propagation ───────────────────────────────────────────────

  describe("abort signal propagation", () => {
    it("pre-aborted signal causes subagent to return early with isError or empty", async () => {
      const controller = new AbortController();
      controller.abort();

      let chatCalled = false;
      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [],
        signal: controller.signal,
        chat: async () => {
          chatCalled = true;
          return { role: "assistant", content: "should not happen" };
        },
      });

      const result = await tool.execute({ task: "aborted task" });
      // With a pre-aborted signal, the loop returns early (no assistant message).
      // extractFinalAnswer returns "" → isError: true "no final answer"
      // OR the loop may not call the chat at all.
      assert.equal(result.isError, true);
      assert.ok(!chatCalled, "chat should not be called when signal is pre-aborted");
    });

    it("execSignal takes precedence over constructor signal", async () => {
      const execController = new AbortController();
      execController.abort();

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [],
        // constructor signal is NOT aborted
        chat: async () => ({ role: "assistant", content: "should not run" }),
      });

      const result = await tool.execute({ task: "exec abort" }, execController.signal);
      assert.equal(result.isError, true);
    });
  });

  // ── LLM config inheritance ─────────────────────────────────────────────────

  describe("LLM config inheritance", () => {
    it("inherits parent LLM config by default", async () => {
      let capturedConfig: import("../src/llm/index.ts").LlmConfig | undefined;
      const chatSpy: ChatFn = async (config) => {
        capturedConfig = config;
        return { role: "assistant", content: "inherited" };
      };

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [],
        chat: chatSpy,
      });

      await tool.execute({ task: "check config" });
      assert.ok(capturedConfig);
      assert.equal(capturedConfig?.model, "faux");
      assert.equal(capturedConfig?.apiKey, "test-key");
    });

    it("uses profile LLM config when profile specifies one", async () => {
      const profileLlm = makeLlmConfig({
        apiKey: "profile-key",
        baseUrl: "http://localhost/v1",
        model: "profile-model",
      });

      let capturedConfig: import("../src/llm/index.ts").LlmConfig | undefined;
      const chatSpy: ChatFn = async (config) => {
        capturedConfig = config;
        return { role: "assistant", content: "profile llm" };
      };

      const profiles: SubagentProfile[] = [
        {
          name: "special",
          description: "uses special model",
          systemPrompt: "special",
          llm: profileLlm,
        },
      ];

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [],
        profiles,
        chat: chatSpy,
      });

      await tool.execute({ task: "special", profile: "special" });
      assert.ok(capturedConfig);
      assert.equal(capturedConfig?.model, "profile-model");
      assert.equal(capturedConfig?.apiKey, "profile-key");
    });
  });

  // ── Integration with parent loop ───────────────────────────────────────────

  describe("integration with parent loop", () => {
    it("parent loop can call subagent and get result as tool output", async () => {
      const { runAgentLoop } = await import("../src/loop.ts");

      const subagentTool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [],
        chat: createImmediateChat("Sub-agent says: hello from the other side"),
      });

      let parentCallCount = 0;
      const parentChat: ChatFn = async () => {
        parentCallCount += 1;
        if (parentCallCount === 1) {
          return {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "parent_call_sub",
                name: "subagent",
                arguments: { task: "say hello" },
              },
            ],
          };
        }
        return { role: "assistant", content: "Parent received sub-agent result." };
      };

      const messages = await runAgentLoop("use subagent", {
        llm: dummyLlm,
        tools: [subagentTool as Tool],
        chat: parentChat,
      });

      const roles = messages.map((m) => m.role);
      assert.deepEqual(roles, ["system", "user", "assistant", "tool", "assistant"]);

      const toolMsg = messages.find((m) => m.role === "tool");
      assert.ok(toolMsg && toolMsg.role === "tool");
      if (toolMsg?.role === "tool") {
        assert.ok(contentAsString(toolMsg.content).includes("hello from the other side"));
        assert.notEqual(toolMsg.isError, true);
      }

      const final = messages[messages.length - 1];
      assert.equal(final.role, "assistant");
      if (final.role === "assistant") {
        assert.ok(final.content.includes("Parent received"));
      }
    });
  });

  // ── Turn counting ──────────────────────────────────────────────────────────

  describe("turn counting", () => {
    it("correctly counts the number of assistant turns", async () => {
      const events: SubagentEvent[] = [];

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [createEchoTool()],
        onSubagentEvent: (event) => events.push(event),
        chat: createToolThenAnswerChat("echo", { message: "x" }, "final"),
      });

      await tool.execute({ task: "count turns" });

      const end = events.find((e) => e.type === "subagent_end");
      assert.ok(end && end.type === "subagent_end");
      if (end?.type === "subagent_end") {
        assert.equal(end.turns, 2); // tool-call assistant + final assistant
      }
    });

    it("reports 1 turn for immediate answers", async () => {
      const events: SubagentEvent[] = [];

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [],
        onSubagentEvent: (event) => events.push(event),
        chat: createImmediateChat("instant"),
      });

      await tool.execute({ task: "one turn" });

      const end = events.find((e) => e.type === "subagent_end");
      assert.ok(end && end.type === "subagent_end");
      if (end?.type === "subagent_end") {
        assert.equal(end.turns, 1);
      }
    });
  });

  // ── ToolProvider function support ──────────────────────────────────────────

  describe("ToolProvider function support", () => {
    it("accepts a ToolProvider function for parentTools", async () => {
      const toolNames: string[] = [];
      const chatSpy: ChatFn = async (_config, _messages, tools) => {
        if (tools) toolNames.push(...tools.map((t: Tool) => t.name));
        return { role: "assistant", content: "dynamic" };
      };

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: () => [createEchoTool()],
        maxDepth: 1,
        currentDepth: 0,
        chat: chatSpy,
      });

      await tool.execute({ task: "dynamic tools" });
      assert.ok(toolNames.includes("echo"));
    });
  });

  // ── Signal merge (both execSignal and constructor signal) ───────────────────

  describe("signal merge", () => {
    it("aborts when constructor signal is pre-aborted even if execSignal is not aborted", async () => {
      const constructorController = new AbortController();
      constructorController.abort(); // pre-abort constructor signal

      let chatCalled = false;
      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [],
        signal: constructorController.signal,
        chat: async () => {
          chatCalled = true;
          return { role: "assistant", content: "should not complete" };
        },
      });

      const execController = new AbortController();
      // execSignal is NOT aborted — only the constructor signal is aborted
      const result = await tool.execute({ task: "merged signal" }, execController.signal);
      // The merged signal should catch constructor abort
      assert.equal(result.isError, true);
      assert.ok(!chatCalled, "chat should not be called when constructor signal is pre-aborted");
    });

    it("aborts when execSignal fires even if constructor signal is not aborted", async () => {
      const execController = new AbortController();
      execController.abort(); // pre-abort execSignal

      const constructorController = new AbortController();
      // constructor signal is NOT aborted

      let chatCalled = false;
      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [],
        signal: constructorController.signal,
        chat: async () => {
          chatCalled = true;
          return { role: "assistant", content: "nope" };
        },
      });

      const result = await tool.execute({ task: "exec aborts" }, execController.signal);
      assert.equal(result.isError, true);
      assert.ok(!chatCalled);
    });
  });

  // ── Token tracking ─────────────────────────────────────────────────────────

  describe("token tracking", () => {
    it("subagent_end totalTokens is 0 when chat provides no usage info", async () => {
      const events: SubagentEvent[] = [];

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [],
        onSubagentEvent: (event) => events.push(event),
        chat: createImmediateChat("no usage"),
      });

      await tool.execute({ task: "token tracking" });

      const end = events.find((e) => e.type === "subagent_end");
      assert.ok(end && end.type === "subagent_end");
      if (end?.type === "subagent_end") {
        assert.equal(end.totalTokens, 0);
      }
    });

    it("subagent_end totalTokens is 0 on error", async () => {
      const events: SubagentEvent[] = [];

      const tool = createSubagentTool({
        parentLlm: dummyLlm,
        parentTools: [],
        onSubagentEvent: (event) => events.push(event),
        chat: async () => { throw new Error("fail"); },
      });

      await tool.execute({ task: "error token tracking" });

      const end = events.find((e) => e.type === "subagent_end");
      assert.ok(end && end.type === "subagent_end");
      if (end?.type === "subagent_end") {
        assert.equal(typeof end.totalTokens, "number");
        assert.equal(end.totalTokens, 0);
      }
    });
  });

  // ── Built-in profiles ──────────────────────────────────────────────────────

  describe("built-in profiles", () => {
    it("defaultProfiles contains researcher, coder, reviewer", async () => {
      const { defaultProfiles } = await import("../src/subagent/index.ts");
      assert.equal(defaultProfiles.length, 3);
      const names = defaultProfiles.map((p: SubagentProfile) => p.name);
      assert.ok(names.includes("researcher"));
      assert.ok(names.includes("coder"));
      assert.ok(names.includes("reviewer"));
    });

    it("each built-in profile has required fields", async () => {
      const { defaultProfiles } = await import("../src/subagent/index.ts");
      for (const profile of defaultProfiles) {
        assert.ok(profile.name, "name is required");
        assert.ok(profile.description, "description is required");
        assert.ok(profile.systemPrompt, "systemPrompt is required");
        assert.ok(Array.isArray(profile.allowedTools), "allowedTools should be an array");
        assert.ok(profile.allowedTools!.length > 0, "allowedTools should not be empty");
        assert.ok(typeof profile.maxTurns === "number", "maxTurns should be a number");
        assert.ok(profile.maxTurns! > 0, "maxTurns should be positive");
      }
    });

    it("researcher profile is read-only (no write/edit tools)", async () => {
      const { researcherProfile } = await import("../src/subagent/index.ts");
      const tools = researcherProfile.allowedTools!;
      assert.ok(!tools.includes("write"), "researcher should not have write");
      assert.ok(!tools.includes("edit"), "researcher should not have edit");
      assert.ok(tools.includes("read"), "researcher should have read");
      assert.ok(tools.includes("grep"), "researcher should have grep");
    });

    it("coder profile has write and edit tools", async () => {
      const { coderProfile } = await import("../src/subagent/index.ts");
      const tools = coderProfile.allowedTools!;
      assert.ok(tools.includes("write"), "coder should have write");
      assert.ok(tools.includes("edit"), "coder should have edit");
      assert.ok(tools.includes("read"), "coder should have read");
    });

    it("reviewer profile is read-only (no write/edit tools)", async () => {
      const { reviewerProfile } = await import("../src/subagent/index.ts");
      const tools = reviewerProfile.allowedTools!;
      assert.ok(!tools.includes("write"), "reviewer should not have write");
      assert.ok(!tools.includes("edit"), "reviewer should not have edit");
      assert.ok(tools.includes("read"), "reviewer should have read");
    });
  });

}); // end parent describe("createSubagentTool")
