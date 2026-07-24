import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseToolArgumentsJson, validateToolArgs } from "../src/validate.ts";
import type { Tool } from "../src/tools/types.ts";

// Helper to create a minimal tool with a given schema
function toolWith(schema: Record<string, unknown>): Tool {
  return {
    name: "test_tool",
    description: "A test tool",
    parameters: schema,
    execute: async () => ({ content: "ok" }),
  };
}

describe("parseToolArgumentsJson", () => {
  it("parses valid JSON object", () => {
    const result = parseToolArgumentsJson('{"path":"file.txt","limit":10}');
    assert.deepEqual(result, { path: "file.txt", limit: 10 });
  });

  it("throws for malformed JSON", () => {
    assert.throws(
      () => parseToolArgumentsJson("{not-json"),
      /Invalid tool arguments JSON/,
    );
  });

  it("throws for JSON array", () => {
    assert.throws(
      () => parseToolArgumentsJson('[1, 2, 3]'),
      /Tool arguments must be a JSON object/,
    );
  });

  it("throws for JSON null", () => {
    assert.throws(
      () => parseToolArgumentsJson("null"),
      /Tool arguments must be a JSON object/,
    );
  });

  it("throws for JSON string", () => {
    assert.throws(
      () => parseToolArgumentsJson('"just a string"'),
      /Tool arguments must be a JSON object/,
    );
  });

  it("throws for JSON number", () => {
    assert.throws(
      () => parseToolArgumentsJson("42"),
      /Tool arguments must be a JSON object/,
    );
  });

  it("accepts empty object", () => {
    const result = parseToolArgumentsJson("{}");
    assert.deepEqual(result, {});
  });
});

describe("validateToolArgs", () => {
  describe("required keys", () => {
    it("passes when all required keys are present", () => {
      const tool = toolWith({
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      });
      const result = validateToolArgs(tool, { path: "file.txt" });
      assert.deepEqual(result, { path: "file.txt" });
    });

    it("throws when a required key is missing", () => {
      const tool = toolWith({
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      });
      assert.throws(
        () => validateToolArgs(tool, {}),
        /Missing required argument: path/,
      );
    });

    it("throws for each missing required key", () => {
      const tool = toolWith({
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      });
      // Missing "path" — should be caught first
      assert.throws(
        () => validateToolArgs(tool, { content: "hello" }),
        /Missing required argument: path/,
      );
    });
  });

  describe("type checks", () => {
    it("validates string type", () => {
      const tool = toolWith({
        type: "object",
        properties: { name: { type: "string" } },
      });
      assert.doesNotThrow(() => validateToolArgs(tool, { name: "Alice" }));
      assert.throws(
        () => validateToolArgs(tool, { name: 42 }),
        /must be a string/,
      );
    });

    it("validates number type", () => {
      const tool = toolWith({
        type: "object",
        properties: { count: { type: "number" } },
      });
      assert.doesNotThrow(() => validateToolArgs(tool, { count: 3.14 }));
      assert.throws(
        () => validateToolArgs(tool, { count: "three" }),
        /must be a number/,
      );
      assert.throws(
        () => validateToolArgs(tool, { count: NaN }),
        /must be a number/,
      );
    });

    it("validates integer type", () => {
      const tool = toolWith({
        type: "object",
        properties: { offset: { type: "integer" } },
      });
      assert.doesNotThrow(() => validateToolArgs(tool, { offset: 5 }));
      assert.throws(
        () => validateToolArgs(tool, { offset: 3.14 }),
        /must be an integer/,
      );
      assert.throws(
        () => validateToolArgs(tool, { offset: "five" }),
        /must be an integer/,
      );
    });

    it("validates integer minimum constraint", () => {
      const tool = toolWith({
        type: "object",
        properties: { offset: { type: "integer", minimum: 1 } },
      });
      assert.doesNotThrow(() => validateToolArgs(tool, { offset: 1 }));
      assert.throws(
        () => validateToolArgs(tool, { offset: 0 }),
        /must be >= 1/,
      );
    });

    it("validates boolean type", () => {
      const tool = toolWith({
        type: "object",
        properties: { verbose: { type: "boolean" } },
      });
      assert.doesNotThrow(() => validateToolArgs(tool, { verbose: true }));
      assert.throws(
        () => validateToolArgs(tool, { verbose: "yes" }),
        /must be a boolean/,
      );
    });
  });

  describe("additionalProperties", () => {
    it("rejects unknown keys when additionalProperties is false", () => {
      const tool = toolWith({
        type: "object",
        properties: { path: { type: "string" } },
        additionalProperties: false,
      });
      assert.throws(
        () => validateToolArgs(tool, { path: "file.txt", extra: "nope" }),
        /Unexpected argument: extra/,
      );
    });

    it("allows unknown keys when additionalProperties is not false", () => {
      const tool = toolWith({
        type: "object",
        properties: { path: { type: "string" } },
      });
      assert.doesNotThrow(() =>
        validateToolArgs(tool, { path: "file.txt", extra: "ok" }),
      );
    });
  });

  describe("edge cases", () => {
    it("passes with no schema at all", () => {
      const tool: Tool = {
        name: "bare",
        description: "no schema",
        parameters: {},
        execute: async () => ({ content: "ok" }),
      };
      const result = validateToolArgs(tool, { anything: "goes" });
      assert.deepEqual(result, { anything: "goes" });
    });

    it("skips type check for undefined property schemas", () => {
      const tool = toolWith({
        type: "object",
        properties: {},
      });
      assert.doesNotThrow(() => validateToolArgs(tool, { unknown: 42 }));
    });

    it("skips type check for unknown type strings", () => {
      const tool = toolWith({
        type: "object",
        properties: { data: { type: "array" } },
      });
      // "array" type is not handled — should pass through
      assert.doesNotThrow(() => validateToolArgs(tool, { data: [1, 2, 3] }));
    });
  });
});
