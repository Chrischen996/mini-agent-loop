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
} from "../src/loop.ts";
import { contentAsString } from "../src/content.ts";
import { makeLlmConfig } from "../src/llm/index.ts";
import { createDefaultTools, createReadTool } from "../src/tools/index.ts";
import type { Tool } from "../src/tools/types.ts";
import {
  createFauxChat,
  createInfiniteToolFauxChat,
  createUnknownToolFauxChat,
} from "./faux-model.ts";

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
