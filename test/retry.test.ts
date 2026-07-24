import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyError,
  getRetryStrategy,
  calculateBackoff,
  isContextOverflowError,
  isAbortError,
  throwIfAborted,
} from "../src/llm/retry.ts";

describe("classifyError", () => {
  it("classifies 429 / rate limit errors", () => {
    assert.equal(classifyError(new Error("HTTP 429 rate limit")), "rate_limit");
    assert.equal(classifyError(new Error("too many requests")), "rate_limit");
    assert.equal(classifyError(new Error("quota exceeded")), "rate_limit");
  });

  it("classifies 502/503/504 server overload errors", () => {
    assert.equal(classifyError(new Error("HTTP 503")), "server_overload");
    assert.equal(classifyError(new Error("server busy")), "server_overload");
    assert.equal(classifyError(new Error("server unavailable")), "server_overload");
    assert.equal(classifyError(new Error("service unavailable")), "server_overload");
    assert.equal(classifyError(new Error("502 Bad Gateway")), "server_overload");
    assert.equal(classifyError(new Error("504 Gateway Timeout")), "server_overload");
  });

  it("classifies network errors", () => {
    assert.equal(classifyError(new Error("ECONNREFUSED")), "network");
    assert.equal(classifyError(new Error("ETIMEDOUT")), "network");
    assert.equal(classifyError(new Error("ENOTFOUND")), "network");
    assert.equal(classifyError(new Error("fetch failed")), "network");
    assert.equal(classifyError(new Error("network error")), "network");
    assert.equal(classifyError(new Error("ECONNRESET")), "network");
  });

  it("classifies internal timeout errors", () => {
    assert.equal(classifyError(new Error("timed out after 30000ms")), "timeout");
  });

  it("classifies context overflow errors", () => {
    assert.equal(classifyError(new Error("context length exceeded")), "context_overflow");
    assert.equal(classifyError(new Error("maximum context window")), "context_overflow");
    assert.equal(classifyError(new Error("prompt is too long")), "context_overflow");
    assert.equal(classifyError(new Error("too many tokens")), "context_overflow");
    assert.equal(classifyError(new Error("token limit reached")), "context_overflow");
  });

  it("returns null for non-retryable errors", () => {
    assert.equal(classifyError(new Error("Invalid API key")), null);
    assert.equal(classifyError(new Error("Model not found")), null);
    assert.equal(classifyError(new Error("Permission denied")), null);
    assert.equal(classifyError(new Error("")), null);
  });

  it("handles non-Error inputs", () => {
    assert.equal(classifyError("rate limit string"), "rate_limit");
    assert.equal(classifyError("plain error"), null);
    assert.equal(classifyError(42), null);
    assert.equal(classifyError(null), null);
  });
});

describe("getRetryStrategy", () => {
  it("returns aggressive backoff for rate_limit", () => {
    const s = getRetryStrategy("rate_limit");
    assert.equal(s.maxRetries, 3);
    assert.ok(s.baseDelayMs >= 2000);
    assert.ok(s.backoffMultiplier >= 3);
  });

  it("returns moderate backoff for server_overload", () => {
    const s = getRetryStrategy("server_overload");
    assert.equal(s.maxRetries, 3);
    assert.ok(s.baseDelayMs >= 1000);
  });

  it("returns quick retry for network", () => {
    const s = getRetryStrategy("network");
    assert.equal(s.maxRetries, 2);
    assert.ok(s.baseDelayMs <= 1000);
  });

  it("returns single retry for timeout", () => {
    const s = getRetryStrategy("timeout");
    assert.equal(s.maxRetries, 1);
    assert.equal(s.baseDelayMs, 0);
  });

  it("returns no retry for context_overflow (handled by compaction)", () => {
    const s = getRetryStrategy("context_overflow");
    assert.equal(s.maxRetries, 0);
  });
});

describe("calculateBackoff", () => {
  it("returns 0 for zero baseDelay strategies", () => {
    const strategy = getRetryStrategy("timeout");
    assert.equal(calculateBackoff(1, strategy), 0);
    assert.equal(calculateBackoff(5, strategy), 0);
  });

  it("grows exponentially for rate_limit strategy", () => {
    const strategy = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 10000, backoffMultiplier: 2 };
    const delay1 = calculateBackoff(1, strategy);
    const delay2 = calculateBackoff(2, strategy);
    const delay3 = calculateBackoff(3, strategy);

    // With jitter ±20%, delay1 should be around 1000, delay2 around 2000, delay3 around 4000
    assert.ok(delay1 >= 800 && delay1 <= 1200, `delay1=${delay1} not in [800,1200]`);
    assert.ok(delay2 >= 1600 && delay2 <= 2400, `delay2=${delay2} not in [1600,2400]`);
    assert.ok(delay3 >= 3200 && delay3 <= 4800, `delay3=${delay3} not in [3200,4800]`);
  });

  it("caps at maxDelayMs", () => {
    const strategy = { maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 5000, backoffMultiplier: 10 };
    const delay = calculateBackoff(3, strategy);
    // 1000 * 10^2 = 100000, capped at 5000, with ±20% jitter: [4000, 6000]
    assert.ok(delay <= 6000, `delay ${delay} exceeds max+jitter`);
    assert.ok(delay >= 4000, `delay ${delay} below min jitter range`);
  });

  it("returns an integer", () => {
    const strategy = getRetryStrategy("rate_limit");
    const delay = calculateBackoff(1, strategy);
    assert.equal(delay, Math.floor(delay));
  });
});

describe("isContextOverflowError", () => {
  it("matches various provider overflow messages", () => {
    const messages = [
      "context length exceeded",
      "maximum context window reached",
      "prompt is too long for this model",
      "too many tokens in the input",
      "token limit exceeded",
      "input token count exceeds limit",
    ];
    for (const msg of messages) {
      assert.ok(isContextOverflowError(new Error(msg)), `should match: "${msg}"`);
    }
  });

  it("does not match unrelated errors", () => {
    assert.ok(!isContextOverflowError(new Error("Invalid API key")));
    assert.ok(!isContextOverflowError(new Error("rate limit")));
  });
});

describe("isAbortError", () => {
  it("detects AbortError by name", () => {
    const err = new Error("operation aborted");
    err.name = "AbortError";
    assert.ok(isAbortError(err));
  });

  it("detects AbortError by message", () => {
    assert.ok(isAbortError(new Error("AbortError: signal was aborted")));
    assert.ok(isAbortError(new Error("The operation was aborted")));
  });

  it("rejects non-abort errors", () => {
    assert.ok(!isAbortError(new Error("network error")));
    assert.ok(!isAbortError(null));
    assert.ok(!isAbortError(undefined));
    assert.ok(!isAbortError("string"));
    assert.ok(!isAbortError(42));
  });
});

describe("throwIfAborted", () => {
  it("does nothing for undefined signal", () => {
    assert.doesNotThrow(() => throwIfAborted(undefined));
  });

  it("does nothing for non-aborted signal", () => {
    const ac = new AbortController();
    assert.doesNotThrow(() => throwIfAborted(ac.signal));
  });

  it("throws AbortError for aborted signal", () => {
    const ac = new AbortController();
    ac.abort();
    assert.throws(
      () => throwIfAborted(ac.signal),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.name, "AbortError");
        return true;
      },
    );
  });
});
