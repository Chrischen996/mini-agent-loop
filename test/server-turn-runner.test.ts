import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeLlmConfig } from "../src/llm/index.ts";
import { MaxTurnsExceededError, type AgentRuntimeRef, type LoopEvent } from "../src/loop.ts";
import { PermissionManager } from "../src/permissions.ts";
import { runServerAgentTurn, type AutoContinueEvent } from "../src/server/turn-runner.ts";
import type { Tool } from "../src/tools/types.ts";
import type { AgentMessage, AssistantMessage } from "../src/types.ts";
import type { WebRunState } from "../src/session-store.ts";

const llm = makeLlmConfig({ apiKey: "test", baseUrl: "http://localhost/v1", model: "faux" });
const read: Tool = {
  name: "read", description: "Read a test value", parameters: { type: "object", properties: {} },
  execute: async () => ({ content: "read result" }),
};
const toolReply = (id: string): AssistantMessage => ({
  role: "assistant", content: "", toolCalls: [{ id, name: "read", arguments: {} }],
});

describe("server turn continuation", () => {
  it("saves a complete tool block before continuing and keeps the active model", async () => {
    const snapshots: AgentMessage[][] = [];
    const runStates: WebRunState[] = [];
    const events: LoopEvent[] = [];
    const continuations: AutoContinueEvent[] = [];
    let calls = 0;
    let executions = 0;
    const result = await runServerAgentTurn([], "read the value", {
      loop: {
        llm, maxTurns: 1,
        tools: [{ ...read, execute: async () => { executions++; return { content: "read result" }; } }],
        chat: async (config, messages) => {
          calls++;
          if (calls === 1) return toolReply("read-1");
          assert.equal(config.model, "switched-faux");
          assert.ok(snapshots.length >= 1);
          assert.equal(messages.filter((message) => message.role === "tool").length, 1);
          return { role: "assistant", content: "finished" };
        },
        prepareNextTurn: () => ({ llm: { ...llm, model: "switched-faux" } }),
        onEvent: (event) => events.push(event),
      },
      persistCheckpoint: async (messages, state) => {
        snapshots.push(structuredClone(messages));
        runStates.push(structuredClone(state));
      },
      onAutoContinue: (event) => continuations.push(event),
    });
    assert.equal(calls, 2);
    assert.equal(executions, 1);
    assert.equal(result.at(-1)?.content, "finished");
    assert.equal(runStates.at(-1)?.status, "completed");
    assert.equal(continuations.length, 1);
    assert.equal(events.some((event) => event.type === "max_turns" || event.type === "error"), false);
    assert.equal(events.filter((event) => event.type === "done").length, 1);
  });

  it("enforces a total limit and only announces the stop after saving progress", async () => {
    let calls = 0;
    let snapshot: AgentMessage[] = [];
    let lastState: WebRunState | undefined;
    const events: LoopEvent[] = [];
    await assert.rejects(runServerAgentTurn([], "keep reading", {
      loop: {
        llm, tools: [read], maxTurns: 2,
        chat: async () => toolReply(`read-${++calls}`),
        onEvent: (event) => {
          if (event.type === "max_turns") assert.deepEqual(snapshot, event.messages);
          events.push(event);
        },
      },
      maxAutoContinues: 1,
      persistCheckpoint: async (messages, state) => {
        snapshot = structuredClone(messages);
        lastState = structuredClone(state);
      },
    }), (error: unknown) => {
      assert.ok(error instanceof MaxTurnsExceededError);
      assert.equal(error.maxTurns, 4);
      assert.match(error.message, /Execution limit reached/);
      assert.equal(error.messages.filter((message) => message.role === "tool").length, 4);
      return true;
    });
    assert.equal(calls, 4);
    assert.equal(events.filter((event) => event.type === "max_turns").length, 1);
    assert.equal(events.some((event) => event.type === "done" || event.type === "error"), false);
    assert.equal(snapshot.at(-1)?.role, "tool");
    assert.equal(lastState?.status, "paused");
    assert.equal(lastState?.reason, "step_limit");
  });

  it("does not repeat automatic preflight delegation on a continuation block", async () => {
    let delegations = 0;
    const subagent: Tool = {
      name: "subagent", description: "Collect a preflight summary",
      parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
      execute: async () => { delegations++; return { content: "preflight summary" }; },
    };
    const result = await runServerAgentTurn([], "Analyze the code and delegate research", {
      loop: {
        llm, tools: [subagent], maxTurns: 1,
        autoSubagent: { enabled: true, minScore: 0 },
        chat: async () => ({ role: "assistant", content: "finished using preflight summary" }),
      },
      persistCheckpoint: async () => {},
    });
    assert.equal(delegations, 1);
    assert.equal(result.at(-1)?.content, "finished using preflight summary");
  });

  it("keeps the token budget across continuation blocks", async () => {
    const runtimeRef: AgentRuntimeRef = {};
    let calls = 0;
    let snapshot: AgentMessage[] = [];
    await assert.rejects(runServerAgentTurn([], "read values", {
      loop: {
        llm, maxTurns: 1, runtimeRef, globalTokenBudget: 2,
        tools: [read],
        chat: async () => ({
          ...toolReply(`read-${++calls}`),
          usage: { promptTokens: 0, inputTokens: 0, completionTokens: 1, totalTokens: 1 },
        }),
      },
      persistCheckpoint: async (messages) => { snapshot = structuredClone(messages); },
    }), /token budget exhausted/);
    assert.equal(calls, 2);
    assert.equal(runtimeRef.globalBudgetState?.used, 2);
    assert.equal(snapshot.filter((message) => message.role === "tool").length, 2);
  });

  it("honors permission changes at a block boundary without another model call", async () => {
    const manager = new PermissionManager("plan");
    const permissionTurn = manager.beginTurn("session", () => {});
    const events: LoopEvent[] = [];
    let lastState: WebRunState | undefined;
    let calls = 0;
    try {
      const messages = await runServerAgentTurn([], "read values", {
        loop: {
          llm, tools: [read], maxTurns: 1, permissionTurn,
          chat: async () => toolReply(`read-${++calls}`),
          onEvent: (event) => events.push(event),
        },
        persistCheckpoint: async (_messages, state) => {
          lastState = structuredClone(state);
          manager.setMode("bypass");
        },
      });
      assert.equal(calls, 1);
      assert.equal(messages.at(-1)?.role, "tool");
      assert.ok(events.some((event) => event.type === "aborted" && event.reason === "permission_mode_changed"));
      assert.equal(lastState?.status, "interrupted");
      assert.equal(events.some((event) => event.type === "max_turns" || event.type === "done"), false);
    } finally {
      permissionTurn.close();
    }
  });

  it("preserves earlier tool results if a later model call fails", async () => {
    let calls = 0;
    let snapshot: AgentMessage[] = [];
    let finalState: WebRunState | undefined;
    await assert.rejects(runServerAgentTurn([], "read values", {
      loop: {
        llm, tools: [read], maxTurns: 1,
        chat: async () => {
          if (++calls === 1) return toolReply("read-1");
          throw new Error("provider failed");
        },
      },
      persistCheckpoint: async (messages, state) => {
        snapshot = structuredClone(messages);
        finalState = structuredClone(state);
      },
    }), /provider failed/);
    assert.equal(calls, 2);
    assert.equal(snapshot.filter((message) => message.role === "tool").length, 1);
    assert.equal(finalState?.status, "failed");
  });

  it("does not continue or claim progress is saved when persistence fails", async () => {
    let calls = 0;
    const events: LoopEvent[] = [];
    const continuations: AutoContinueEvent[] = [];
    await assert.rejects(runServerAgentTurn([], "read values", {
      loop: {
        llm, tools: [read], maxTurns: 1,
        chat: async () => toolReply(`read-${++calls}`),
        onEvent: (event) => events.push(event),
      },
      persistCheckpoint: async () => { throw new Error("disk full"); },
      onAutoContinue: (event) => continuations.push(event),
    }), /disk full/);
    assert.equal(calls, 1);
    assert.equal(continuations.length, 0);
    assert.equal(events.some((event) => event.type === "max_turns"), false);
  });

  it("does not announce successful completion before its history is saved", async () => {
    const events: LoopEvent[] = [];
    await assert.rejects(runServerAgentTurn([], "answer directly", {
      loop: {
        llm, tools: [], chat: async () => ({ role: "assistant", content: "answer" }),
        onEvent: (event) => events.push(event),
      },
      persistCheckpoint: async () => { throw new Error("disk full"); },
    }), /disk full/);
    assert.equal(events.some((event) => event.type === "done"), false);
  });
});
