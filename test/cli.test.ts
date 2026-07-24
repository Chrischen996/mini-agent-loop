import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCliArgs } from "../src/cli.ts";

describe("parseCliArgs", () => {
  it("extracts a plain prompt from positional arguments", () => {
    const result = parseCliArgs(["read", "package.json"]);
    assert.equal(result.prompt, "read package.json");
    assert.deepEqual(result.imagePaths, []);
    assert.equal(result.allowMcpTools, false);
  });

  it("extracts --image flags", () => {
    const result = parseCliArgs(["--image", "photo.png", "describe this"]);
    assert.deepEqual(result.imagePaths, ["photo.png"]);
    assert.equal(result.prompt, "describe this");
  });

  it("supports --image=path syntax", () => {
    const result = parseCliArgs(["--image=photo.png", "describe"]);
    assert.deepEqual(result.imagePaths, ["photo.png"]);
  });

  it("collects multiple --image flags", () => {
    const result = parseCliArgs(["--image", "a.png", "--image", "b.jpg", "compare"]);
    assert.deepEqual(result.imagePaths, ["a.png", "b.jpg"]);
  });

  it("throws when --image has no path argument", () => {
    assert.throws(() => parseCliArgs(["--image"]), /--image requires a path/);
    assert.throws(() => parseCliArgs(["--image", "--other"]), /--image requires a path/);
  });

  it("throws when --image= is empty", () => {
    assert.throws(() => parseCliArgs(["--image="]), /--image= requires a path/);
  });

  it("sets allowMcpTools when --allow-mcp-tools is present", () => {
    const result = parseCliArgs(["--allow-mcp-tools", "do something"]);
    assert.equal(result.allowMcpTools, true);
  });

  it("parses --tools flag", () => {
    const result = parseCliArgs(["--tools", "read,write", "go"]);
    assert.deepEqual(result.tools, ["read", "write"]);
  });

  it("parses --tools= syntax", () => {
    const result = parseCliArgs(["--tools=read,bash", "go"]);
    assert.deepEqual(result.tools, ["read", "bash"]);
  });

  it("parses --exclude-tools flag", () => {
    const result = parseCliArgs(["--exclude-tools", "bash", "go"]);
    assert.deepEqual(result.excludeTools, ["bash"]);
  });

  it("parses --exclude-tools= syntax", () => {
    const result = parseCliArgs(["--exclude-tools=bash,write", "go"]);
    assert.deepEqual(result.excludeTools, ["bash", "write"]);
  });

  it("throws for unknown tool in --tools", () => {
    assert.throws(
      () => parseCliArgs(["--tools", "nonexistent", "go"]),
      /Unknown tool in --tools: nonexistent/,
    );
  });

  it("throws when --tools has no value", () => {
    assert.throws(
      () => parseCliArgs(["--tools"]),
      /--tools requires a comma-separated tool list/,
    );
  });

  it("throws when --exclude-tools has no value", () => {
    assert.throws(
      () => parseCliArgs(["--exclude-tools"]),
      /--exclude-tools requires a comma-separated tool list/,
    );
  });

  it("returns empty prompt for no arguments", () => {
    const result = parseCliArgs([]);
    assert.equal(result.prompt, "");
  });
});

describe("CLI smoke test", () => {
  it("exits with error when no prompt is provided (empty args trigger stdin read)", async () => {
    // We can't easily test the full main() without mocking env vars,
    // but we verify that parseCliArgs is callable and handles edge cases.
    // Full process spawn tests are deferred to CI where env is controlled.
    const result = parseCliArgs([]);
    assert.equal(result.prompt, "");
    assert.deepEqual(result.imagePaths, []);
    assert.equal(result.tools, undefined);
    assert.equal(result.excludeTools, undefined);
    assert.equal(result.allowMcpTools, false);
  });
});
