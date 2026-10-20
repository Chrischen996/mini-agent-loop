import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { TuiAgentTurnResult } from "../src/tui/agent-turn.js";
import type { AgentMessage } from "../src/types.js";
import { executeAutoContinue, isTruncatedTurn } from "../src/tui/auto-continue-orchestrator.js";

describe("auto-continue-orchestrator", () => {
  describe("isTruncatedTurn", () => {
    it("should detect truncation from stop.reason", () => {
      const result: TuiAgentTurnResult = {
        history: [],
        stop: { reason: "failed", details: "LLM output reached max_tokens" },
      };
      assert.equal(isTruncatedTurn(result), true);
    });

    it("should detect truncation from finish_reason", () => {
      const result: TuiAgentTurnResult = {
        history: [
          { role: "assistant", content: "test" },
        ] as AgentMessage[],
        stop: { reason: "failed", details: "finish_reason: length" },
      };
      assert.equal(isTruncatedTurn(result), true);
    });

    it("should return false for non-truncation errors", () => {
      const result: TuiAgentTurnResult = {
        history: [],
        stop: { reason: "failed", details: "Network timeout" },
      };
      assert.equal(isTruncatedTurn(result), false);
    });

    it("should return false for successful turns", () => {
      const result: TuiAgentTurnResult = {
        history: [{ role: "assistant", content: "done" }] as AgentMessage[],
      };
      assert.equal(isTruncatedTurn(result), false);
    });
  });

  describe("executeAutoContinue", () => {
    it("should stop after maxAttempts if still truncated", async () => {
      const mockRunFn = mock.fn(
        async (_history: AgentMessage[], _prompt: string, _options: any) =>
          ({
            history: [{ role: "assistant", content: "partial" }] as AgentMessage[],
            stop: { reason: "failed", details: "max_tokens reached" },
          }) as TuiAgentTurnResult,
      );

      const onProgress = mock.fn();

      const result = await executeAutoContinue(
        [],
        mockRunFn,
        { llm: {} as any, tools: () => [] },
        {
          config: { enabled: true, maxAttempts: 2, delayMs: 10 },
          attemptCount: 0,
          onProgress,
        },
      );

      assert.equal(mockRunFn.mock.calls.length, 2);
      assert.equal(onProgress.mock.calls.length, 2);
      assert.deepEqual(onProgress.mock.calls[0].arguments, [1, 2]);
      assert.deepEqual(onProgress.mock.calls[1].arguments, [2, 2]);
      assert.equal(result.truncated, true);
    });

    it("should succeed when continuation completes", async () => {
      let callCount = 0;
      const mockRunFn = mock.fn(async (_history: AgentMessage[], _prompt: string, _options: any) => {
        callCount++;
        if (callCount === 1) {
          return {
            history: [{ role: "assistant", content: "part1" }] as AgentMessage[],
            stop: { reason: "failed", details: "max_tokens" },
          } as TuiAgentTurnResult;
        }
        return {
          history: [
            { role: "assistant", content: "part1" },
            { role: "assistant", content: "part2" },
          ] as AgentMessage[],
        } as TuiAgentTurnResult;
      });

      const result = await executeAutoContinue(
        [],
        mockRunFn,
        { llm: {} as any, tools: () => [] },
        {
          config: { enabled: true, maxAttempts: 3, delayMs: 10 },
          attemptCount: 0,
          onProgress: ((_count: number, _max: number) => {}) as any,
        },
      );

      assert.equal(mockRunFn.mock.calls.length, 2);
      assert.equal(result.truncated, false);
      assert.equal(result.history.length, 2);
    });

    it("should respect delayMs between attempts", async () => {
      const mockRunFn = mock.fn(
        async (_history: AgentMessage[], _prompt: string, _options: any) =>
          ({
            history: [],
            stop: { reason: "failed", details: "max_tokens" },
          }) as TuiAgentTurnResult,
      );

      const start = Date.now();
      await executeAutoContinue(
        [],
        mockRunFn,
        { llm: {} as any, tools: () => [] },
        {
          config: { enabled: true, maxAttempts: 2, delayMs: 100 },
          attemptCount: 0,
          onProgress: ((_count: number, _max: number) => {}) as any,
        },
      );
      const elapsed = Date.now() - start;

      assert.ok(elapsed >= 100, `Expected elapsed time >= 100ms, got ${elapsed}ms`);
      assert.equal(mockRunFn.mock.calls.length, 2);
    });

    it("should call onProgress with correct count and max", async () => {
      const mockRunFn = mock.fn(
        async (_history: AgentMessage[], _prompt: string, _options: any) =>
          ({
            history: [],
            stop: { reason: "failed", details: "max_tokens" },
          }) as TuiAgentTurnResult,
      );

      const onProgress = mock.fn();

      await executeAutoContinue(
        [],
        mockRunFn,
        { llm: {} as any, tools: () => [] },
        {
          config: { enabled: true, maxAttempts: 3, delayMs: 10 },
          attemptCount: 0,
          onProgress,
        },
      );

      assert.equal(onProgress.mock.calls.length, 3);
      assert.deepEqual(onProgress.mock.calls[0].arguments, [1, 3]);
      assert.deepEqual(onProgress.mock.calls[1].arguments, [2, 3]);
      assert.deepEqual(onProgress.mock.calls[2].arguments, [3, 3]);
    });

    it("should handle unlimited attempts (maxAttempts = 0)", async () => {
      let callCount = 0;
      const mockRunFn = mock.fn(async (_history: AgentMessage[], _prompt: string, _options: any) => {
        callCount++;
        if (callCount < 10) {
          return {
            history: [],
            stop: { reason: "failed", details: "max_tokens" },
          } as TuiAgentTurnResult;
        }
        return { history: [{ role: "assistant", content: "done" }] as AgentMessage[] } as TuiAgentTurnResult;
      });

      const result = await executeAutoContinue(
        [],
        mockRunFn,
        { llm: {} as any, tools: () => [] },
        {
          config: { enabled: true, maxAttempts: 0, delayMs: 1 },
          attemptCount: 0,
          onProgress: ((_count: number, _max: number) => {}) as any,
        },
      );

      assert.equal(callCount, 10);
      assert.equal(result.truncated, false);
    });
  });
});
