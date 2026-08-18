import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filterModelsByQuery,
  hasGatewayOverrides,
  modelSearchQuery,
  parseModelCommand,
  shouldSubmitTypedModelCommand,
} from "../src/tui/model-command.ts";
import { getAllModels } from "../src/models.ts";
import { SLASH_COMMANDS } from "../src/tui/components/FileAutocomplete.tsx";

describe("parseModelCommand", () => {
  it("keeps a bare model reference", () => {
    assert.deepEqual(parseModelCommand("xai/grok-3"), {
      reference: "xai/grok-3",
      overrides: {},
    });
  });

  it("parses positional gateway url and api key", () => {
    assert.deepEqual(
      parseModelCommand("xai/grok-3 https://api.sparkcode.top/v1 sk-test-key"),
      {
        reference: "xai/grok-3",
        overrides: {
          baseUrl: "https://api.sparkcode.top/v1",
          apiKey: "sk-test-key",
        },
      },
    );
  });

  it("parses a positional url without a key", () => {
    assert.deepEqual(parseModelCommand("xai/grok-3 https://api.sparkcode.top/v1"), {
      reference: "xai/grok-3",
      overrides: { baseUrl: "https://api.sparkcode.top/v1" },
    });
  });

  it("still accepts flag overrides", () => {
    assert.deepEqual(
      parseModelCommand("xai/grok-3 --base-url https://gw.example/v1 --api-key sk-flag"),
      {
        reference: "xai/grok-3",
        overrides: {
          baseUrl: "https://gw.example/v1",
          apiKey: "sk-flag",
        },
      },
    );
  });

  it("resolves --api-key-env from the provided env", () => {
    assert.deepEqual(
      parseModelCommand("xai/grok-3 --api-key-env CUSTOM_KEY", { CUSTOM_KEY: "from-env" }),
      {
        reference: "xai/grok-3",
        overrides: { apiKey: "from-env" },
      },
    );
  });

  it("lets flags win over positional url/key", () => {
    assert.deepEqual(
      parseModelCommand(
        "xai/grok-3 https://positional.example/v1 sk-positional --base-url https://flag.example/v1 --api-key sk-flag",
      ),
      {
        reference: "xai/grok-3",
        overrides: {
          baseUrl: "https://flag.example/v1",
          apiKey: "sk-flag",
        },
      },
    );
  });

  it("returns an empty reference for a blank command", () => {
    assert.deepEqual(parseModelCommand("   "), { reference: "", overrides: {} });
  });

  it("extracts only the model needle from a typed /model line", () => {
    assert.equal(
      modelSearchQuery("/model xai/grok-3 https://api.sparkcode.top/v1 sk-test-key"),
      "xai/grok-3",
    );
  });

  it("submits a typed command when the reference is exact or has gateway overrides", () => {
    assert.equal(shouldSubmitTypedModelCommand("/model xai/grok-3"), true);
    assert.equal(
      shouldSubmitTypedModelCommand("/model xai/grok-3 https://api.sparkcode.top/v1 sk-test-key"),
      true,
    );
    assert.equal(shouldSubmitTypedModelCommand("/model grok"), false);
    assert.equal(hasGatewayOverrides({ baseUrl: "https://gw.example/v1", apiKey: "sk" }), true);
    assert.equal(hasGatewayOverrides({ baseUrl: "https://gw.example/v1" }), false);
  });
});

describe("filterModelsByQuery", () => {
  const models = getAllModels();

  it("returns the full catalog for an empty query", () => {
    assert.equal(filterModelsByQuery("", models).length, models.length);
    assert.equal(filterModelsByQuery("   ", models).length, models.length);
  });

  it("uses simple provider/id substring matching", () => {
    const results = filterModelsByQuery("grok-3", models);
    assert.ok(results.some((model) => model.provider === "xai" && model.id === "grok-3"));
    assert.ok(results.every((model) => `${model.provider}/${model.id}`.toLowerCase().includes("grok-3")));
  });

  it("does not AND extra url/key tokens into the query", () => {
    const parsed = parseModelCommand("xai/grok-3 https://api.sparkcode.top/v1 sk-test-key");
    const results = filterModelsByQuery(parsed.reference, models);
    assert.ok(results.some((model) => model.provider === "xai" && model.id === "grok-3"));
    assert.equal(filterModelsByQuery("xai/grok-3 https://api.sparkcode.top/v1 sk-test-key", models).length, 0);
  });
});

describe("slash command help", () => {
  it("documents positional /model arguments", () => {
    const model = SLASH_COMMANDS.find((command) => command.name === "model");
    assert.ok(model);
    assert.match(model.usage, /\[url\]/);
    assert.match(model.usage, /\[key\]/);
  });
});
