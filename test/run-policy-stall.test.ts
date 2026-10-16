import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeLlmConfig } from "../src/llm/index.ts";
import { runAgentTurn, RunStoppedError, type LoopEvent } from "../src/loop.ts";
import type { Tool } from "../src/tools/types.ts";

const llm = makeLlmConfig({ apiKey: "test", baseUrl: "http://localhost/v1", model: "faux" });

const repeatTool: Tool = {
  name: "read_repeat",
  description: "Reads the same file over and over",
  parameters: { type: "object", properties: { file: { type: "string" } } },
  execute: async () => ({ content: "file content identical" }),
};

describe("AgentRunPolicy and stall detection in core loop", () => {
  it("stops with 'stalled' when calling the same tool and arguments repeatedly", async () => {
    let calls = 0;
    const events: LoopEvent[] = [];

    await assert.rejects(
      runAgentTurn([], "read repeatedly", {
        llm,
        tools: [repeatTool],
        runPolicy: {
          stallPolicy: { sameActionLimit: 3 },
        },
        chat: async () => {
          calls += 1;
          return {
            role: "assistant",
            content: "",
            toolCalls: [{ id: `call-${calls}`, name: "read_repeat", arguments: { file: "same.txt" } }],
          };
        },
        onEvent: (e) => events.push(e),
      }),
      (err: unknown) => {
        assert.ok(err instanceof RunStoppedError);
        assert.equal(err.stopReason, "stalled");
        assert.match(err.details ?? "", /repeated action/i);
        return true;
      },
    );

    assert.equal(calls, 4);
    assert.ok(events.some((e) => e.type === "run_stopped" && e.stopReason === "stalled"));
  });

  it("stops with 'budget_exhausted' when tool call budget is reached", async () => {
    let calls = 0;
    const events: LoopEvent[] = [];

    await assert.rejects(
      runAgentTurn([], "run tools", {
        llm,
        tools: [repeatTool],
        runPolicy: {
          toolCallBudget: 2,
        },
        chat: async () => {
          calls += 1;
          return {
            role: "assistant",
            content: "",
            toolCalls: [{ id: `call-${calls}`, name: "read_repeat", arguments: { file: `diff-${calls}.txt` } }],
          };
        },
        onEvent: (e) => events.push(e),
      }),
      (err: unknown) => {
        assert.ok(err instanceof RunStoppedError);
        assert.equal(err.stopReason, "budget_exhausted");
        return true;
      },
    );

    assert.ok(events.some((e) => e.type === "run_stopped" && e.stopReason === "budget_exhausted"));
  });

  it("completes normally without maxTurns errors when task finishes within emergency cap", async () => {
    let calls = 0;
    const result = await runAgentTurn([], "quick question", {
      llm,
      tools: [repeatTool],
      runPolicy: {
        emergencyIterationCap: 100,
      },
      chat: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-1", name: "read_repeat", arguments: { file: "info.txt" } }],
          };
        }
        return { role: "assistant", content: "Final answer after reading info." };
      },
    });

    assert.equal(calls, 2);
    assert.equal(result.at(-1)?.content, "Final answer after reading info.");
  });
});
