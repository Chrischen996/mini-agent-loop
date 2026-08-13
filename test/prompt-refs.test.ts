import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildModelPrompt } from "../src/server.ts";

describe("buildModelPrompt", () => {
  it("appends referenced file block to user text", () => {
    const result = buildModelPrompt({
      prompt: "总结这些文件",
      referencedPaths: ["src/loop.ts", "package.json"],
      hasImages: false,
    });
    assert.equal(result.displayPrompt, "总结这些文件");
    assert.match(result.modelPrompt, /总结这些文件/);
    assert.match(result.modelPrompt, /Referenced workspace files/);
    assert.match(result.modelPrompt, /- src\/loop\.ts/);
    assert.match(result.modelPrompt, /- package\.json/);
  });

  it("uses default display/model text when only refs are present", () => {
    const result = buildModelPrompt({
      prompt: "  ",
      referencedPaths: ["package.json"],
      hasImages: false,
    });
    assert.match(result.displayPrompt, /请阅读引用的文件/);
    assert.match(result.modelPrompt, /请阅读引用的文件/);
    assert.match(result.modelPrompt, /package\.json/);
  });

  it("strips /think:auto and selects adaptive thinking mode", () => {
    const result = buildModelPrompt({
      prompt: "/think:auto 修复类型检查失败",
      referencedPaths: [],
      hasImages: false,
    });
    assert.equal(result.displayPrompt, "修复类型检查失败");
    assert.equal(result.modelPrompt, "修复类型检查失败");
    assert.equal(result.thinkingLevel, null);
    assert.equal(result.thinkingMode, "adaptive");
  });
});
