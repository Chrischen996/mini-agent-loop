import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LlmRetryCoordinator, waitForRetry } from "../src/llm/recovery.ts";
import { LlmTimeoutError } from "../src/llm/retry.ts";

describe("LLM retry coordinator", () => {
  it("limits request-level retries independently by error type", () => {
    const coordinator = new LlmRetryCoordinator();
    const first = coordinator.next(new Error("LLM network error: ECONNRESET"));
    assert.equal(first?.errorType, "network");
    assert.equal(first?.attempt, 1);
    assert.equal(coordinator.next(new Error("LLM network error: ECONNRESET"))?.attempt, 2);
    assert.equal(coordinator.next(new Error("LLM network error: ECONNRESET")), undefined);
    assert.equal(coordinator.next(new Error("HTTP 503 service unavailable"))?.attempt, 1);
    assert.equal(coordinator.attemptsFor("network"), 2);
  });

  it("leaves timeout and context overflow recovery to the loop", () => {
    const coordinator = new LlmRetryCoordinator();
    assert.equal(coordinator.next(new Error("context window exceeded")), undefined);
    assert.equal(coordinator.next(new LlmTimeoutError()), undefined);
  });

  it("honors cancellation while waiting for backoff", async () => {
    const controller = new AbortController();
    const pending = waitForRetry(50, controller.signal);
    controller.abort(new Error("cancelled"));
    await assert.rejects(pending, /cancelled/);
  });
});
