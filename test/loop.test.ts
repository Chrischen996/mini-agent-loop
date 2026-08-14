import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createAgentHistory,
  MaxTurnsExceededError,
  runAgentLoop,
  runAgentTurn,
  buildSystemPrompt,
} from "../src/loop.ts";
import { contentAsString } from "../src/content.ts";
import { makeLlmConfig } from "../src/llm/index.ts";
import { LlmTimeoutError } from "../src/llm/retry.ts";
import { createDefaultTools, createReadTool } from "../src/tools/index.ts";
import type { Tool } from "../src/tools/types.ts";
import { PermissionManager } from "../src/permissions.ts";
import {
  createFauxChat,
  createInfiniteToolFauxChat,
  createUnknownToolFauxChat,
} from "./faux-model.ts";
import { streamChat } from "../src/llm/index.ts";
import type { AgentMessage } from "../src/types.ts";

const dummyLlm = makeLlmConfig({
  apiKey: "test-key",
  baseUrl: "http://localhost/v1",
  model: "faux",
});

describe("runAgentLoop", () => {
  it("happy path: user -> assistant(toolCalls) -> tool -> assistant(text)", async () => {
    const tools = createDefaultTools(process.cwd());
    const chat = createFauxChat({
      readPath: "package.json",
      toolCallId: "call_read_1",
    });

    const messages = await runAgentLoop("read package.json and summarize", {
      llm: dummyLlm,
      tools,
      chat,
    });

    const roles = messages.map((m) => m.role);
    assert.deepEqual(roles, ["system", "user", "assistant", "tool", "assistant"]);

    const firstAssistant = messages[2];
    assert.equal(firstAssistant.role, "assistant");
    if (firstAssistant.role !== "assistant") return;
    assert.ok(firstAssistant.toolCalls?.length === 1);
    assert.equal(firstAssistant.toolCalls?.[0]?.name, "read");
    assert.equal(firstAssistant.toolCalls?.[0]?.id, "call_read_1");

    const toolMsg = messages[3];
    assert.equal(toolMsg.role, "tool");
    if (toolMsg.role !== "tool") return;
    assert.equal(toolMsg.toolCallId, "call_read_1");
    assert.equal(toolMsg.name, "read");
    assert.notEqual(toolMsg.isError, true);
    assert.match(
      contentAsString(toolMsg.content),
      /"name"\s*:\s*"@krischen99999\/mini-agent-loop"/,
    );

    const finalAssistant = messages[4];
    assert.equal(finalAssistant.role, "assistant");
    if (finalAssistant.role !== "assistant") return;
    assert.ok(!finalAssistant.toolCalls?.length);
    assert.match(finalAssistant.content, /mini-agent/);
  });

  it("every tool call id has a matching tool result", async () => {
    const tools = createDefaultTools(process.cwd());
    const chat = createFauxChat({ toolCallId: "id_must_match" });

    const messages = await runAgentLoop("test pairing", {
      llm: dummyLlm,
      tools,
      chat,
    });

    const callIds = messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => (m.role === "assistant" ? m.toolCalls ?? [] : []))
      .map((c) => c.id);

    const resultIds = messages
      .filter((m) => m.role === "tool")
      .map((m) => (m.role === "tool" ? m.toolCallId : ""));

    for (const id of callIds) {
      assert.ok(
        resultIds.includes(id),
        `missing tool result for tool call id ${id}`,
      );
    }
  });

  it("records paired automatic validation after a successful write", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-auto-validation-"));
    try {
      await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }), "utf8");
      let calls = 0;
      const messages = await runAgentLoop("write", {
        llm: dummyLlm,
        tools: [{
          name: "write",
          description: "write",
          parameters: { type: "object" },
          execute: async () => ({ content: "written" }),
        }],
        autoValidate: true,
        validationWorkspace: root,
        chat: async () => {
          calls += 1;
          return calls === 1
            ? { role: "assistant", content: "", toolCalls: [{ id: "write_1", name: "write", arguments: {} }] }
            : { role: "assistant", content: "done" };
        },
      });
      const validationAssistant = messages.find((message) => message.role === "assistant" && message.toolCalls?.[0]?.name === "validate_workspace");
      const validationTool = messages.find((message) => message.role === "tool" && message.name === "validate_workspace");
      assert.ok(validationAssistant);
      assert.ok(validationTool && validationTool.role === "tool");
      if (validationAssistant?.role === "assistant" && validationTool?.role === "tool") {
        assert.equal(validationTool.toolCallId, validationAssistant.toolCalls?.[0]?.id);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unknown tool becomes isError tool result without throwing", async () => {
    const tools = createDefaultTools(process.cwd());
    const chat = createUnknownToolFauxChat("call_unknown_1");

    const messages = await runAgentLoop("call a missing tool", {
      llm: dummyLlm,
      tools,
      chat,
    });

    const toolMsg = messages.find((m) => m.role === "tool");
    assert.ok(toolMsg && toolMsg.role === "tool");
    if (!toolMsg || toolMsg.role !== "tool") return;
    assert.equal(toolMsg.isError, true);
    assert.match(contentAsString(toolMsg.content), /Unknown tool: not_a_real_tool/);

    const final = messages[messages.length - 1];
    assert.equal(final.role, "assistant");
  });

  it("validation failure becomes isError tool result without throwing", async () => {
    const tools = createDefaultTools(process.cwd());
    let callCount = 0;
    const chat = async (): Promise<import("../src/types.ts").AssistantMessage> => {
      callCount += 1;
      if (callCount === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_bad_args",
              name: "read",
              // missing required path
              arguments: { limit: 1 },
            },
          ],
        };
      }
      return { role: "assistant", content: "handled validation error" };
    };

    const messages = await runAgentLoop("bad args", {
      llm: dummyLlm,
      tools,
      chat,
    });

    const toolMsg = messages.find((m) => m.role === "tool");
    assert.ok(toolMsg && toolMsg.role === "tool");
    if (!toolMsg || toolMsg.role !== "tool") return;
    assert.equal(toolMsg.isError, true);
    assert.match(contentAsString(toolMsg.content), /Missing required argument: path/);
  });

  it("exceeding maxTurns preserves partial history in a typed stop error", async () => {
    const tools = createDefaultTools(process.cwd());
    const chat = createInfiniteToolFauxChat();
    const events: import("../src/loop.ts").LoopEvent[] = [];

    await assert.rejects(
      () => runAgentLoop("loop forever", { llm: dummyLlm, tools, chat, maxTurns: 2, onEvent: (event) => events.push(event) }),
      (error: unknown) => {
        assert.ok(error instanceof MaxTurnsExceededError);
        assert.equal(error.maxTurns, 2);
        assert.equal(error.messages.filter((message) => message.role === "tool").length, 2);
        return true;
      },
    );
    assert.ok(events.some((event) => event.type === "max_turns" && event.maxTurns === 2));
  });
});

describe("runAgentTurn", () => {
  it("applies a leading thinking command before the first model call and cleans the prompt", async () => {
    let capturedConfig: typeof dummyLlm | undefined;
    let capturedMessages: import("../src/types.ts").AgentMessage[] | undefined;
    const reasoningLlm = makeLlmConfig({
      apiKey: "test",
      baseUrl: "http://localhost/v1",
      model: "faux",
      reasoning: true,
      thinkingLevel: "medium",
    });

    const messages = await runAgentTurn(createAgentHistory(), "/think:high inspect this", {
      llm: reasoningLlm,
      tools: [],
      chat: async (config, inputMessages) => {
        capturedConfig = config;
        capturedMessages = inputMessages;
        return { role: "assistant", content: "done" };
      },
    });

    assert.equal(capturedConfig?.thinkingLevel, "high");
    assert.equal(capturedMessages?.find((message) => message.role === "user")?.content, "inspect this");
    assert.equal(messages.find((message) => message.role === "user")?.content, "inspect this");
  });

  it("emits an adaptive initial decision before the first model call", async () => {
    const configs: typeof dummyLlm[] = [];
    const events: import("../src/loop.ts").LoopEvent[] = [];
    const reasoningLlm = makeLlmConfig({
      apiKey: "test",
      baseUrl: "http://localhost/v1",
      model: "faux",
      reasoning: true,
      thinkingLevel: "medium",
    });

    await runAgentTurn(createAgentHistory(), "Explain this module", {
      llm: reasoningLlm,
      tools: [],
      thinkingMode: "adaptive",
      onEvent: (event) => events.push(event),
      chat: async (config) => {
        configs.push(config);
        return { role: "assistant", content: "done" };
      },
    });

    assert.equal(configs[0]?.thinkingLevel, "low");
    const policyEvent = events.find((event) => event.type === "thinking_policy");
    assert.ok(policyEvent && policyEvent.type === "thinking_policy");
    if (policyEvent?.type === "thinking_policy") {
      assert.equal(policyEvent.phase, "initial");
      assert.equal(policyEvent.level, "low");
    }
  });

  it("escalates adaptive effort after a tool failure for the next model call", async () => {
    const configs: typeof dummyLlm[] = [];
    const events: import("../src/loop.ts").LoopEvent[] = [];
    let calls = 0;
    const reasoningLlm = makeLlmConfig({
      apiKey: "test",
      baseUrl: "http://localhost/v1",
      model: "faux",
      reasoning: true,
      thinkingLevel: "medium",
    });
    const failingTool: Tool = {
      name: "failing_tool",
      description: "always fails",
      parameters: { type: "object" },
      execute: async () => ({ content: "failure", isError: true }),
    };

    await runAgentTurn(createAgentHistory(), "Explain this failure", {
      llm: reasoningLlm,
      tools: [failingTool],
      thinkingMode: "adaptive",
      onEvent: (event) => events.push(event),
      chat: async (config) => {
        configs.push(config);
        calls += 1;
        return calls === 1
          ? { role: "assistant", content: "", toolCalls: [{ id: "failure_1", name: "failing_tool", arguments: {} }] }
          : { role: "assistant", content: "recovered" };
      },
    });

    assert.deepEqual(configs.map((config) => config.thinkingLevel), ["low", "medium"]);
    const escalation = events.find((event) => event.type === "thinking_policy" && event.phase === "escalation");
    assert.ok(escalation && escalation.type === "thinking_policy");
    if (escalation?.type === "thinking_policy") {
      assert.equal(escalation.previousLevel, "low");
      assert.equal(escalation.level, "medium");
      assert.deepEqual(escalation.reasons, ["tool_failure"]);
    }
  });

  it("keeps an explicit thinking command fixed when adaptive is the default", async () => {
    let capturedConfig: typeof dummyLlm | undefined;
    const events: import("../src/loop.ts").LoopEvent[] = [];
    const reasoningLlm = makeLlmConfig({
      apiKey: "test",
      baseUrl: "http://localhost/v1",
      model: "faux",
      reasoning: true,
      thinkingLevel: "medium",
    });

    await runAgentTurn(createAgentHistory(), "/think:high Explain this module", {
      llm: reasoningLlm,
      tools: [],
      thinkingMode: "adaptive",
      onEvent: (event) => events.push(event),
      chat: async (config) => {
        capturedConfig = config;
        return { role: "assistant", content: "done" };
      },
    });

    assert.equal(capturedConfig?.thinkingLevel, "high");
    assert.equal(events.some((event) => event.type === "thinking_policy"), false);
  });

  it("retries a reasoning-only assistant response before completing", async () => {
    let calls = 0;
    const messages = await runAgentTurn(createAgentHistory(), "continue", {
      llm: dummyLlm,
      tools: [],
      chat: async () => {
        calls += 1;
        return calls === 1
          ? { role: "assistant", content: "" }
          : { role: "assistant", content: "continued" };
      },
    });

    assert.equal(calls, 2);
    assert.equal(messages.at(-1)?.role, "assistant");
    assert.equal(messages.at(-1)?.content, "continued");
  });

  it("compacts before a model call and emits a context event", async () => {
    const events: import("../src/loop.ts").LoopEvent[] = [];
    const history = [
      ...createAgentHistory("system"),
      ...Array.from({ length: 8 }, (_, index) => ({ role: "user" as const, content: `message ${index} ${"x".repeat(80)}` })),
    ];
    const messages = await runAgentTurn(history, "latest", {
      llm: makeLlmConfig({ apiKey: "test", baseUrl: "http://localhost/v1", model: "faux", contextWindow: 100, maxTokens: 20 }),
      tools: [],
      context: { keepRecentMessages: 2 },
      onEvent: (event) => events.push(event),
      chat: async () => ({ role: "assistant", content: "ok" }),
    });
    assert.equal(messages.at(-1)?.role, "assistant");
    assert.ok(events.some((event) => event.type === "context_compacted"));
  });

  it("does not compact a short Grok conversation with the balanced output budget", async () => {
    const events: import("../src/loop.ts").LoopEvent[] = [];
    const grok = makeLlmConfig({
      apiKey: "test",
      baseUrl: "https://gateway.example/v1",
      model: "xai/grok-4.5",
    });
    await runAgentTurn(createAgentHistory("system"), "hello", {
      llm: grok,
      tools: [],
      onEvent: (event) => events.push(event),
      chat: async () => ({ role: "assistant", content: "ok" }),
    });

    assert.equal(grok.maxTokens, 32_768);
    assert.equal(events.some((event) => event.type === "context_compacted"), false);
  });

  it("respects an explicit context reserve independently from the request output limit", async () => {
    const events: import("../src/loop.ts").LoopEvent[] = [];
    const history = [
      ...createAgentHistory("system"),
      ...Array.from({ length: 8 }, (_, index) => ({ role: "user" as const, content: `message ${index} ${"x".repeat(80)}` })),
    ];
    await runAgentTurn(history, "latest", {
      llm: makeLlmConfig({ apiKey: "test", baseUrl: "http://localhost/v1", model: "faux", contextWindow: 500, maxTokens: 200 }),
      tools: [],
      context: { reserveTokens: 10, keepRecentMessages: 2 },
      onEvent: (event) => events.push(event),
      chat: async () => ({ role: "assistant", content: "ok" }),
    });

    assert.equal(events.some((event) => event.type === "context_compacted"), false);
  });

  it("retries one provider context overflow after compaction", async () => {
    let calls = 0;
    const events: import("../src/loop.ts").LoopEvent[] = [];
    const history = [
      ...createAgentHistory("system"),
      ...Array.from({ length: 5 }, (_, index) => ({ role: "user" as const, content: `message ${index}` })),
    ];
    const messages = await runAgentTurn(history, "latest", {
      llm: makeLlmConfig({ apiKey: "test", baseUrl: "http://localhost/v1", model: "faux" }),
      tools: [],
      onEvent: (event) => events.push(event),
      chat: async () => {
        calls += 1;
        if (calls === 1) throw new Error("context length exceeded");
        return { role: "assistant", content: "recovered" };
      },
    });
    assert.equal(calls, 2);
    assert.equal(messages.at(-1)?.role, "assistant");
    assert.ok(events.some((event) => event.type === "context_compacted" && event.reason === "provider context overflow"));
  });

  it("prepareNextTurn: switches model between turns and emits model_switched event", async () => {
    const modelsUsed: string[] = [];
    const events: import("../src/loop.ts").LoopEvent[] = [];

    // Turn 1: returns a tool call. Turn 2: returns plain text (after model switch).
    let callCount = 0;
    const chat = async (
      config: typeof dummyLlm,
      _messages: import("../src/types.ts").AgentMessage[],
      _tools: unknown,
    ): Promise<import("../src/types.ts").AssistantMessage> => {
      modelsUsed.push(config.model);
      callCount += 1;
      if (callCount === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "read", arguments: { path: "package.json" } }],
        };
      }
      return { role: "assistant", content: "done" };
    };

    const altLlm = makeLlmConfig({
      apiKey: "alt-key",
      baseUrl: "http://localhost/v1",
      model: "gpt-4o",
    });

    const messages = await runAgentTurn(createAgentHistory(), "go", {
      llm: dummyLlm,
      tools: createDefaultTools(process.cwd()),
      chat,
      onEvent: (event) => events.push(event),
      prepareNextTurn: ({ toolResults, currentLlm }) => {
        // After a turn with tool calls, switch to altLlm
        if (toolResults.length > 0 && currentLlm.model !== altLlm.model) {
          return { llm: altLlm };
        }
      },
    });

    assert.equal(modelsUsed[0], "faux", "first turn uses original model");
    assert.equal(modelsUsed[1], "gpt-4o", "second turn uses switched model");
    const switchEvent = events.find((e) => e.type === "model_switched");
    assert.ok(switchEvent && switchEvent.type === "model_switched");
    if (switchEvent?.type === "model_switched") {
      assert.equal(switchEvent.previousModel, "faux");
      assert.equal(switchEvent.nextModel, "gpt-4o");
      assert.equal(switchEvent.turn, 1);
    }
    assert.equal(messages.at(-1)?.role, "assistant");
  });

  it("prepareNextTurn: no update returned leaves model unchanged", async () => {
    const modelsUsed: string[] = [];
    let callCount = 0;
    const chat = async (
      config: typeof dummyLlm,
    ): Promise<import("../src/types.ts").AssistantMessage> => {
      modelsUsed.push(config.model);
      callCount += 1;
      if (callCount === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_2", name: "read", arguments: { path: "package.json" } }],
        };
      }
      return { role: "assistant", content: "unchanged" };
    };

    await runAgentTurn(createAgentHistory(), "go", {
      llm: dummyLlm,
      tools: createDefaultTools(process.cwd()),
      chat,
      prepareNextTurn: () => undefined,
    });

    assert.ok(modelsUsed.every((m) => m === "faux"), "model stays unchanged");
  });

  it("prepareNextTurn: receives correct TurnContext fields", async () => {
    let capturedCtx: import("../src/loop.ts").TurnContext | undefined;
    let callCount = 0;
    const chat = async (): Promise<import("../src/types.ts").AssistantMessage> => {
      callCount += 1;
      if (callCount === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_3", name: "read", arguments: { path: "package.json" } }],
        };
      }
      return { role: "assistant", content: "ctx-verified" };
    };

    await runAgentTurn(createAgentHistory(), "verify ctx", {
      llm: dummyLlm,
      tools: createDefaultTools(process.cwd()),
      chat,
      prepareNextTurn: (ctx) => {
        // Capture only the first call (turn with tool results)
        if (!capturedCtx) capturedCtx = ctx;
        return undefined;
      },
    });

    assert.ok(capturedCtx, "prepareNextTurn was called");
    assert.equal(capturedCtx?.turn, 1);
    assert.equal(capturedCtx?.currentLlm.model, "faux");
    assert.ok(Array.isArray(capturedCtx?.toolResults) && capturedCtx.toolResults.length === 1);
    assert.ok(capturedCtx?.messages.length > 0);
    assert.equal(capturedCtx?.assistantMessage.role, "assistant");
  });

  it("resolves a dynamic tool provider before every inner turn", async () => {
    const refreshedTool: Tool = {
      name: "refreshed",
      description: "available after refresh",
      parameters: { type: "object" },
      execute: async () => ({ content: "refreshed" }),
    };
    let catalog: Tool[];
    const refreshTool: Tool = {
      name: "refresh",
      description: "refresh tools",
      parameters: { type: "object" },
      execute: async () => {
        catalog = [refreshedTool];
        return { content: "updated" };
      },
    };
    catalog = [refreshTool];
    const seen: string[][] = [];
    const chat = async (
      _config: typeof dummyLlm,
      _messages: import("../src/types.ts").AgentMessage[],
      tools: Tool[] = [],
    ): Promise<import("../src/types.ts").AssistantMessage> => {
      seen.push(tools.map((tool) => tool.name));
      if (seen.length === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "refresh_1", name: "refresh", arguments: {} }],
        };
      }
      return { role: "assistant", content: "saw refreshed tools" };
    };

    await runAgentTurn(createAgentHistory(), "refresh", {
      llm: dummyLlm,
      tools: () => [...catalog],
      chat,
    });

    assert.deepEqual(seen, [["refresh"], ["refreshed"]]);
  });

  it("executes multiple tool calls in parallel when parallelToolExecution is true", async () => {
    const executionOrder: string[] = [];
    const slowTool: Tool = {
      name: "slow",
      description: "a slow tool",
      parameters: { type: "object", properties: { id: { type: "string" } } },
      execute: async (args) => {
        executionOrder.push(`start:${args.id}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
        executionOrder.push(`end:${args.id}`);
        return { content: `done:${args.id}` };
      },
    };

    let callCount = 0;
    const chat = async (): Promise<import("../src/types.ts").AssistantMessage> => {
      callCount += 1;
      if (callCount === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "c1", name: "slow", arguments: { id: "A" } },
            { id: "c2", name: "slow", arguments: { id: "B" } },
          ],
        };
      }
      return { role: "assistant", content: "parallel done" };
    };

    const messages = await runAgentTurn(createAgentHistory(), "go parallel", {
      llm: dummyLlm,
      tools: [slowTool],
      chat,
      parallelToolExecution: true,
    });

    // Both tools should have started before either finished (parallel)
    const startA = executionOrder.indexOf("start:A");
    const startB = executionOrder.indexOf("start:B");
    const endA = executionOrder.indexOf("end:A");
    const endB = executionOrder.indexOf("end:B");
    assert.ok(startA < endA, "A starts before ending");
    assert.ok(startB < endB, "B starts before ending");
    // In parallel, both starts happen before both ends
    assert.ok(startA < endB && startB < endA, "tools run concurrently");

    // Results are in original call order
    const toolMsgs = messages.filter((m) => m.role === "tool");
    assert.equal(toolMsgs.length, 2);
    if (toolMsgs[0]?.role === "tool" && toolMsgs[1]?.role === "tool") {
      assert.equal(toolMsgs[0].toolCallId, "c1");
      assert.equal(toolMsgs[1].toolCallId, "c2");
    }

    assert.equal(messages.at(-1)?.content, "parallel done");
  });

  it("preserves history without repeating the system message", async () => {
    const chat = async (
      _config: typeof dummyLlm,
      messages: import("../src/types.ts").AgentMessage[],
    ): Promise<import("../src/types.ts").AssistantMessage> => {
      const users = messages.filter((message) => message.role === "user").length;
      return { role: "assistant", content: `turn ${users}` };
    };
    const first = await runAgentTurn(createAgentHistory("system once"), "first", {
      llm: dummyLlm,
      tools: [],
      chat,
    });
    const second = await runAgentTurn(first, "second", {
      llm: dummyLlm,
      tools: [],
      chat,
    });

    assert.equal(second.filter((message) => message.role === "system").length, 1);
    assert.equal(second.filter((message) => message.role === "user").length, 2);
    assert.equal(second.filter((message) => message.role === "assistant").length, 2);
    assert.equal(second.at(-1)?.role, "assistant");
    if (second.at(-1)?.role === "assistant") {
      assert.equal(second.at(-1)?.content, "turn 2");
    }
  });

  it("injects plan mode notice into system message during runAgentTurn", async () => {
    const chat = async () => ({ role: "assistant" as const, content: "ok" });
    const history = createAgentHistory("custom system", "plan");
    const messages = await runAgentTurn(history, "write a file", {
      llm: dummyLlm,
      tools: [],
      chat,
      permissionMode: "plan",
    });
    const systemMsg = messages.find((m) => m.role === "system");
    assert.ok(systemMsg);
    assert.ok(typeof systemMsg.content === "string");
    assert.ok((systemMsg.content as string).includes("计划模式"));
    assert.ok((systemMsg.content as string).includes("无权限改代码"));
    assert.ok((systemMsg.content as string).includes("custom system"));
  });

  it("does not inject plan mode notice in auto mode", async () => {
    const chat = async () => ({ role: "assistant" as const, content: "ok" });
    const history = createAgentHistory("custom system", "auto");
    const messages = await runAgentTurn(history, "write a file", {
      llm: dummyLlm,
      tools: [],
      chat,
      permissionMode: "auto",
    });
    const systemMsg = messages.find((m) => m.role === "system");
    assert.ok(systemMsg);
    assert.ok(typeof systemMsg.content === "string");
    assert.ok(!(systemMsg.content as string).includes("计划模式"));
  });

  it("does not duplicate plan mode notice on subsequent turns", async () => {
    const chat = async (
      _config: typeof dummyLlm,
      messages: import("../src/types.ts").AgentMessage[],
    ): Promise<import("../src/types.ts").AssistantMessage> => {
      const users = messages.filter((message) => message.role === "user").length;
      return { role: "assistant", content: `turn ${users}` };
    };
    // Start with a custom system prompt (no permission mode awareness section)
    const first = await runAgentTurn(createAgentHistory("custom system"), "first", {
      llm: dummyLlm,
      tools: [],
      chat,
      permissionMode: "plan",
    });
    const second = await runAgentTurn(first, "second", {
      llm: dummyLlm,
      tools: [],
      chat,
      permissionMode: "plan",
    });

    const systemMsgs = second.filter((m) => m.role === "system");
    assert.equal(systemMsgs.length, 1);
    // Should have the original custom system content plus the injected notice
    const content = systemMsgs[0]!.content as string;
    assert.ok(content.includes("custom system"));
    assert.ok(content.includes("计划模式"));
    assert.ok(content.includes("无权限改代码"));
    // The explicit "no permission to edit code" sentence should only appear once.
    const noticeCount = content.match(/我当前处于计划模式，无权限改代码。/g)?.length ?? 0;
    assert.equal(noticeCount, 1);
  });

  it("buildSystemPrompt includes Permission Mode Awareness section", () => {
    const prompt = buildSystemPrompt("plan");
    assert.ok(prompt.includes("Permission Mode Awareness"));
    assert.ok(prompt.includes("plan mode"));
    assert.ok(prompt.includes("manual mode"));
    assert.ok(prompt.includes("auto mode"));
    assert.ok(prompt.includes("bypass mode"));
    assert.ok(prompt.includes("无权限改代码"));
    for (const mode of ["plan", "manual", "auto", "bypass"]) {
      assert.ok(buildSystemPrompt(mode as "plan" | "manual" | "auto" | "bypass").includes(`mode=${mode}`));
    }
  });

  it("uses one permission snapshot for the prompt and tools across a mode switch", async () => {
    const manager = new PermissionManager("auto");
    let releaseModel: (() => void) | undefined;
    let toolExecutions = 0;
    let firstSystemPrompt = "";
    const writeTool: Tool = {
      name: "write",
      description: "write",
      parameters: { type: "object" },
      execute: async () => {
        toolExecutions += 1;
        return { content: "should not run" };
      },
    };
    const firstTurn = manager.beginTurn("loop-switch", () => {});
    const firstRun = runAgentTurn(createAgentHistory(undefined, "auto"), "make a change", {
      llm: dummyLlm,
      tools: [writeTool],
      permissionTurn: firstTurn,
      chat: async (_config, messages) => {
        const system = messages.find((message) => message.role === "system");
        firstSystemPrompt = system && typeof system.content === "string" ? system.content : "";
        await new Promise<void>((resolve) => { releaseModel = resolve; });
        return {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "stale-write", name: "write", arguments: {} }],
        };
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(firstSystemPrompt, /mode=auto/);
    manager.setMode("bypass");
    releaseModel?.();
    const aborted = await firstRun;
    assert.equal(toolExecutions, 0);
    assert.equal(aborted.some((message) => message.role === "tool"), false);
    firstTurn.close();

    let nextSystemPrompt = "";
    const nextTurn = manager.beginTurn("loop-switch", () => {});
    await runAgentTurn(aborted, "continue", {
      llm: dummyLlm,
      tools: [writeTool],
      permissionTurn: nextTurn,
      chat: async (_config, messages) => {
        const system = messages.find((message) => message.role === "system");
        nextSystemPrompt = system && typeof system.content === "string" ? system.content : "";
        return { role: "assistant", content: "done" };
      },
    });
    assert.match(nextSystemPrompt, /mode=bypass/);
    assert.doesNotMatch(nextSystemPrompt, /mode=auto/);
    nextTurn.close();
  });
});

describe("createReadTool", () => {
  it("reads package.json content", async () => {
    const tool = createReadTool(process.cwd());
    const result = await tool.execute({ path: "package.json" });
    assert.notEqual(result.isError, true);
    assert.match(
      contentAsString(result.content),
      /"name"\s*:\s*"@krischen99999\/mini-agent-loop"/,
    );
  });

  it("missing file returns isError without throwing", async () => {
    const tool = createReadTool(process.cwd());
    const result = await tool.execute({ path: "does-not-exist-xyz.txt" });
    assert.equal(result.isError, true);
    assert.match(contentAsString(result.content), /File not found/);
  });

  it("path escape outside cwd returns isError", async () => {
    const tool = createReadTool(process.cwd());
    const result = await tool.execute({ path: "../outside.txt" });
    assert.equal(result.isError, true);
    assert.match(contentAsString(result.content), /escapes workspace cwd/);
  });

  it("symlink escape outside cwd returns isError", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-read-"));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside.txt");

    try {
      await mkdir(workspace);
      await writeFile(outside, "outside secret", "utf8");
      await symlink(outside, path.join(workspace, "linked.txt"));

      const result = await createReadTool(workspace).execute({
        path: "linked.txt",
      });
      assert.equal(result.isError, true);
      assert.match(contentAsString(result.content), /resolves outside workspace cwd/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("LlmTimeoutError in loop", () => {
  it("does NOT throw MaxTurnsExceededError when stream hits LlmTimeoutError with partial content", async () => {
    const events: import("../src/loop.ts").LoopEvent[] = [];
    const originalFetch = globalThis.fetch;

    // Return a response that yields one delta then hangs forever,
    // causing the internal request timeout to fire and throw LlmTimeoutError.
    globalThis.fetch = (async () => new Response(
      new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"par"}}]}\n\n',
            ),
          );
          // Never enqueue more data — the request will timeout.
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    )) as typeof fetch;

    try {
      const llm = makeLlmConfig({
        apiKey: "test-key",
        baseUrl: "http://localhost/v1",
        model: "gpt-4o-mini",
        timeoutMs: 20,
      });

      await assert.rejects(
        () =>
          runAgentTurn(createAgentHistory(), "hello", {
            llm,
            tools: [],
            onEvent: (event) => events.push(event),
          }),
        (err: unknown) => {
          // Must be LlmTimeoutError, NOT MaxTurnsExceededError
          assert.ok(
            err instanceof LlmTimeoutError,
            `expected LlmTimeoutError but got ${(err as Error)?.constructor?.name ?? String(err)}`,
          );
          assert.ok(!(err instanceof MaxTurnsExceededError), "must not throw MaxTurnsExceededError");
          return true;
        },
      );
      // The partial assistant message should have been saved via onEvent.
      assert.ok(events.some((e) => e.type === "assistant_delta" && e.kind === "answer"), "should have emitted answer delta");
      assert.ok(events.some((e) => e.type === "assistant"), "should have emitted partial assistant message");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
