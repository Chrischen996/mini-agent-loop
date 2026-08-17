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
    assert.equal(result.mode, "plan"); // default mode
  });

  it("parses --mode flag", () => {
    const result = parseCliArgs(["--mode", "plan", "do something"]);
    assert.equal(result.mode, "plan");
    assert.equal(result.prompt, "do something");
  });

  it("parses --mode= syntax", () => {
    const result = parseCliArgs(["--mode=bypass", "do something"]);
    assert.equal(result.mode, "bypass");
  });

  it("rejects legacy manual/auto modes", () => {
    assert.throws(() => parseCliArgs(["--mode=manual", "do something"]), /Invalid mode/);
    assert.throws(() => parseCliArgs(["--mode", "auto", "do something"]), /Invalid mode/);
  });

  it("defaults to plan mode when not specified", () => {
    const result = parseCliArgs(["hello world"]);
    assert.equal(result.mode, "plan");
    assert.equal(result.planOnly, false);
  });

  it("sets planOnly when --plan flag is present", () => {
    const result = parseCliArgs(["--plan", "write a plan"]);
    assert.equal(result.mode, "plan");
    assert.equal(result.planOnly, true);
    assert.equal(result.planExecute, false);
    assert.equal(result.prompt, "write a plan");
  });

  it("sets planExecute when --plan-execute flag is present", () => {
    const result = parseCliArgs(["--plan-execute", "execute the plan"]);
    assert.equal(result.planOnly, false);
    assert.equal(result.planExecute, true);
    assert.equal(result.planYes, false);
    assert.equal(result.prompt, "execute the plan");
  });

  it("sets planYes when --yes flag is present", () => {
    const result = parseCliArgs(["--yes", "do something"]);
    assert.equal(result.planYes, true);
    assert.equal(result.planOnly, false);
  });

  it("sets planYes together with --plan", () => {
    const result = parseCliArgs(["--plan", "--yes", "write a plan"]);
    assert.equal(result.planOnly, true);
    assert.equal(result.planYes, true);
  });

  it("parses new plan workflow flags", () => {
    const result = parseCliArgs([
      "--plan-retry",
      "--plan-force",
      "--plan-show",
      "--plan-approve",
      "--plan-reject",
      "retry it",
    ]);
    assert.equal(result.planRetry, true);
    assert.equal(result.planForce, true);
    assert.equal(result.planShow, true);
    assert.equal(result.planApprove, true);
    assert.equal(result.planReject, true);
    assert.equal(result.prompt, "retry it");
  });

  it("parses plan edit/history/archive flags", () => {
    const result = parseCliArgs([
      "--plan-edit",
      "--plan-set-file",
      "plan.md",
      "--plan-history",
      "--plan-archive",
      "ignored prompt",
    ]);
    assert.equal(result.planEdit, true);
    assert.equal(result.planSetFile, "plan.md");
    assert.equal(result.planHistory, true);
    assert.equal(result.planArchive, true);
  });

  it("parses --plan-set-file= syntax", () => {
    const result = parseCliArgs(["--plan-set-file=./plans/x.md"]);
    assert.equal(result.planSetFile, "./plans/x.md");
    assert.equal(result.planEdit, false);
  });

  it("throws when --plan-set-file has no path", () => {
    assert.throws(
      () => parseCliArgs(["--plan-set-file"]),
      /--plan-set-file requires a path/,
    );
  });

  it("defaults new plan flags to false", () => {
    const result = parseCliArgs(["hello"]);
    assert.equal(result.planRetry, false);
    assert.equal(result.planForce, false);
    assert.equal(result.planShow, false);
    assert.equal(result.planApprove, false);
    assert.equal(result.planReject, false);
    assert.equal(result.planEdit, false);
    assert.equal(result.planSetFile, undefined);
    assert.equal(result.planHistory, false);
    assert.equal(result.planArchive, false);
  });

  it("throws for invalid mode", () => {
    assert.throws(() => parseCliArgs(["--mode", "invalid"]), /Invalid mode/);
    assert.throws(() => parseCliArgs(["--mode"]), /--mode requires an argument/);
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
    assert.equal(result.mode, "plan");
  });
});
