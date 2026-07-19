import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyRelay,
  applyRelayIfMatched,
  createKeyResolver,
  matchRelay,
  parseRelayRegistry,
  type RelayEntry,
  type RelayRegistry,
} from "../src/relay.ts";
import { makeLlmConfig } from "../src/llm.ts";

// ─── fixtures ─────────────────────────────────────────────────────────────────

const baseConfig = makeLlmConfig({
  apiKey: "original-key",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
});

function makeRelay(overrides: Partial<RelayEntry> = {}): RelayEntry {
  return {
    baseUrl: "https://relay.example.com/v1",
    apiKey: "relay-key",
    ...overrides,
  };
}

// ─── matchRelay ───────────────────────────────────────────────────────────────

describe("matchRelay", () => {
  it("returns undefined for an empty registry", () => {
    assert.equal(matchRelay([], "openai", "gpt-4o"), undefined);
  });

  it("matches a catch-all entry (no providers, no models)", () => {
    const relay = makeRelay();
    assert.strictEqual(matchRelay([relay], "openai", "gpt-4o"), relay);
    assert.strictEqual(matchRelay([relay], "anthropic", "claude-opus-4"), relay);
  });

  it("matches provider wildcard '*'", () => {
    const relay = makeRelay({ providers: ["*"] });
    assert.strictEqual(matchRelay([relay], "openai", "gpt-4o"), relay);
    assert.strictEqual(matchRelay([relay], "deepseek", "deepseek-v3"), relay);
  });

  it("matches specific provider (case-insensitive)", () => {
    const relay = makeRelay({ providers: ["OpenAI"] });
    assert.strictEqual(matchRelay([relay], "openai", "gpt-4o"), relay);
    assert.equal(matchRelay([relay], "anthropic", "claude-3"), undefined);
  });

  it("matches specific model (case-insensitive)", () => {
    const relay = makeRelay({ providers: ["openai"], models: ["GPT-4O"] });
    assert.strictEqual(matchRelay([relay], "openai", "gpt-4o"), relay);
    assert.equal(matchRelay([relay], "openai", "gpt-4o-mini"), undefined);
  });

  it("first match wins when multiple entries exist", () => {
    const specific = makeRelay({ providers: ["openai"], models: ["gpt-4o"], baseUrl: "https://specific.example.com/v1" });
    const catchAll = makeRelay({ baseUrl: "https://catchall.example.com/v1" });
    const registry: RelayRegistry = [specific, catchAll];

    const matched = matchRelay(registry, "openai", "gpt-4o");
    assert.strictEqual(matched, specific);
    assert.equal(matched?.baseUrl, "https://specific.example.com/v1");

    // other model falls through to catch-all
    const fallback = matchRelay(registry, "openai", "gpt-4o-mini");
    assert.strictEqual(fallback, catchAll);
  });

  it("returns undefined when provider does not match any entry", () => {
    const relay = makeRelay({ providers: ["openai"] });
    assert.equal(matchRelay([relay], "anthropic", "claude-3"), undefined);
  });
});

// ─── createKeyResolver ────────────────────────────────────────────────────────

describe("createKeyResolver", () => {
  it("returns static string as-is", async () => {
    const resolver = createKeyResolver("static-key");
    assert.equal(await resolver(), "static-key");
    assert.equal(await resolver(), "static-key");
  });

  it("rotates through a key pool round-robin", async () => {
    const resolver = createKeyResolver(["k1", "k2", "k3"]);
    assert.equal(await resolver(), "k1");
    assert.equal(await resolver(), "k2");
    assert.equal(await resolver(), "k3");
    // wraps around
    assert.equal(await resolver(), "k1");
  });

  it("calls a factory function for dynamic keys", async () => {
    let callCount = 0;
    const resolver = createKeyResolver(() => {
      callCount += 1;
      return `token-${callCount}`;
    });
    assert.equal(await resolver(), "token-1");
    assert.equal(await resolver(), "token-2");
    assert.equal(callCount, 2);
  });

  it("supports async factory functions", async () => {
    const resolver = createKeyResolver(async () => "async-token");
    assert.equal(await resolver(), "async-token");
  });

  it("throws for empty key pool", () => {
    assert.throws(() => createKeyResolver([]), /must not be empty/);
  });

  it("each resolver has independent rotation state", async () => {
    const pool = ["a", "b"];
    const r1 = createKeyResolver(pool);
    const r2 = createKeyResolver(pool);
    assert.equal(await r1(), "a");
    assert.equal(await r1(), "b");
    // r2 starts its own counter at 0
    assert.equal(await r2(), "a");
  });
});

// ─── applyRelay ───────────────────────────────────────────────────────────────

describe("applyRelay", () => {
  it("replaces baseUrl and adds getApiKey", async () => {
    const relay = makeRelay({ baseUrl: "https://relay.example.com/v1/", apiKey: "relay-key" });
    const result = applyRelay(baseConfig, relay);

    assert.equal(result.baseUrl, "https://relay.example.com/v1"); // trailing slash stripped
    assert.equal(typeof result.getApiKey, "function");
    assert.equal(await result.getApiKey!(), "relay-key");
  });

  it("preserves all other LlmConfig fields", () => {
    const relay = makeRelay();
    const result = applyRelay(baseConfig, relay);

    assert.equal(result.model, baseConfig.model);
    assert.equal(result.provider, baseConfig.provider);
    assert.equal(result.contextWindow, baseConfig.contextWindow);
    assert.equal(result.maxTokens, baseConfig.maxTokens);
    assert.equal(result.reasoning, baseConfig.reasoning);
  });

  it("static apiKey field is kept unchanged (getApiKey overrides at request time)", () => {
    const relay = makeRelay({ apiKey: "relay-key" });
    const result = applyRelay(baseConfig, relay);
    // Static field still has original value; getApiKey() is the authoritative source
    assert.equal(result.apiKey, baseConfig.apiKey);
  });
});

// ─── applyRelayIfMatched ─────────────────────────────────────────────────────

describe("applyRelayIfMatched", () => {
  it("returns config unchanged when registry is empty", () => {
    const result = applyRelayIfMatched(baseConfig, []);
    assert.strictEqual(result, baseConfig);
  });

  it("returns config unchanged when no entry matches", () => {
    // Use a catch-all config but a relay that only matches "anthropic" — no match
    const anthropicConfig = { ...baseConfig, provider: "anthropic" };
    const relay = makeRelay({ providers: ["openai"] });
    const result = applyRelayIfMatched(anthropicConfig, [relay]);
    assert.strictEqual(result, anthropicConfig);
  });

  it("applies relay when entry matches via catch-all (no providers filter)", async () => {
    const relay = makeRelay({ apiKey: "matched-key" }); // catch-all: no providers/models
    const result = applyRelayIfMatched(baseConfig, [relay]);
    assert.equal(result.baseUrl, "https://relay.example.com/v1");
    assert.equal(await result.getApiKey!(), "matched-key");
  });

  it("applies relay when provider matches explicitly", async () => {
    // Construct a config with a known provider to avoid resolution ambiguity
    const config = { ...baseConfig, provider: "openai", model: "gpt-4o-mini" };
    const relay = makeRelay({ providers: ["openai"], apiKey: "openai-relay-key" });
    const result = applyRelayIfMatched(config, [relay]);
    assert.equal(result.baseUrl, "https://relay.example.com/v1");
    assert.equal(await result.getApiKey!(), "openai-relay-key");
  });
});

// ─── parseRelayRegistry ───────────────────────────────────────────────────────

describe("parseRelayRegistry", () => {
  it("returns empty array for undefined input", () => {
    assert.deepEqual(parseRelayRegistry(undefined), []);
  });

  it("returns empty array for empty string", () => {
    assert.deepEqual(parseRelayRegistry(""), []);
  });

  it("returns empty array for invalid JSON", () => {
    assert.deepEqual(parseRelayRegistry("{invalid json}"), []);
  });

  it("parses a single relay object", () => {
    const raw = JSON.stringify({ baseUrl: "https://relay.example.com/v1", apiKey: "key" });
    const registry = parseRelayRegistry(raw);
    assert.equal(registry.length, 1);
    assert.equal(registry[0]?.baseUrl, "https://relay.example.com/v1");
  });

  it("parses an array of relay entries", () => {
    const raw = JSON.stringify([
      { baseUrl: "https://relay1.example.com/v1", apiKey: "key1", providers: ["openai"] },
      { baseUrl: "https://relay2.example.com/v1", apiKey: "key2", providers: ["anthropic"] },
    ]);
    const registry = parseRelayRegistry(raw);
    assert.equal(registry.length, 2);
    assert.equal(registry[0]?.baseUrl, "https://relay1.example.com/v1");
    assert.equal(registry[1]?.baseUrl, "https://relay2.example.com/v1");
  });

  it("skips entries missing required fields", () => {
    const raw = JSON.stringify([
      { apiKey: "key-no-url" },          // missing baseUrl
      { baseUrl: "" },                   // empty baseUrl
      { baseUrl: "https://valid.example.com/v1", apiKey: "valid-key" },
    ]);
    const registry = parseRelayRegistry(raw);
    assert.equal(registry.length, 1);
    assert.equal(registry[0]?.baseUrl, "https://valid.example.com/v1");
  });

  it("parses a key pool (array of strings)", () => {
    const raw = JSON.stringify({
      baseUrl: "https://relay.example.com/v1",
      apiKey: ["k1", "k2", "k3"],
    });
    const registry = parseRelayRegistry(raw);
    assert.equal(registry.length, 1);
    assert.ok(Array.isArray(registry[0]?.apiKey));
  });

  it("skips entries with invalid apiKey type", () => {
    const raw = JSON.stringify({
      baseUrl: "https://relay.example.com/v1",
      apiKey: 12345, // number is invalid
    });
    assert.deepEqual(parseRelayRegistry(raw), []);
  });

  it("parses providers and models filters", () => {
    const raw = JSON.stringify({
      baseUrl: "https://relay.example.com/v1",
      apiKey: "key",
      providers: ["openai", "anthropic"],
      models: ["gpt-4o"],
    });
    const registry = parseRelayRegistry(raw);
    assert.equal(registry.length, 1);
    assert.deepEqual(registry[0]?.providers, ["openai", "anthropic"]);
    assert.deepEqual(registry[0]?.models, ["gpt-4o"]);
  });
});
