import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { noticeText, noticeTitle, statusLabel } from "../src/tui/claude-style.ts";

describe("Claude-style status presentation", () => {
  it("prioritizes plan review over generic generation status", () => {
    assert.equal(statusLabel("计划已生成，等待审批"), "Plan ready for review");
  });

  it("maps transient internal statuses to stable English labels", () => {
    assert.equal(statusLabel("请求超时，正在重试 (1/3)", true), "Retrying…");
    assert.equal(statusLabel("权限模式: 审批"), "Default permissions");
    assert.equal(statusLabel("会话已恢复"), "Session resumed");
    assert.equal(statusLabel("已停止"), "Cancelled");
  });

  it("maps subagent lifecycle statuses without leaking Chinese chrome", () => {
    assert.equal(statusLabel("子代理 (depth 1)...", true), "Delegating…");
    assert.equal(statusLabel("子代理完成"), "Done");
    assert.equal(statusLabel("子代理失败"), "Failed");
  });

  it("maps the English subagent and orchestration statuses the same way", () => {
    assert.equal(statusLabel("Auto subagent started (researcher, score=0.8)"), "Delegating…");
    assert.equal(statusLabel("Subagent delegation suggested (researcher, score=0.8)"), "Delegating…");
    assert.equal(statusLabel("Orchestration: researcher (exploration 1/3)"), "Delegating…");
    assert.equal(statusLabel("Orchestration disabled"), "Orchestration off");
    assert.equal(statusLabel("Auto subagent done"), "Done");
    assert.equal(statusLabel("Auto subagent failed"), "Failed");
    assert.equal(statusLabel("Post-edit verification passed"), "Post-edit verification passed");
    assert.equal(statusLabel("Aborted"), "Cancelled");
    assert.equal(statusLabel("Context compacted 1200 → 800 tokens"), "Context compacted");
  });

  it("resolves control notices to the label the status row pins", () => {
    // The reducer writes the label, the legacy client writes the raw mode; both
    // must land on the same text so `idleStatusTail` can suppress the echo.
    assert.equal(statusLabel("Permission mode: Plan mode"), "Plan mode");
    assert.equal(statusLabel("Permission mode: approval"), "Default permissions");
    assert.equal(statusLabel("Permission mode: bypass"), "Bypass permissions");
    assert.equal(statusLabel("Thinking level: 高"), "high");
    assert.equal(statusLabel("Thinking display: hidden"), "Thinking display: hidden");
  });

  it("keeps legacy notice bodies instead of blanking untranslated lines", () => {
    // The translation layer is a compatibility shim for sessions persisted
    // before notices became English. Its old fallback dropped every line that
    // still contained Chinese, which silently emptied real diagnostics.
    assert.equal(noticeText("Agent 未返回可保存的计划内容。"), "Agent 未返回可保存的计划内容。");
    assert.equal(noticeText("已复制 12 条消息"), "已复制 12 messages");
    assert.equal(noticeText("No saved sessions."), "No saved sessions.");
    assert.notEqual(noticeText("上下文: 1200 tokens · 本轮输出: 300 tokens").trim(), "");
    assert.equal(noticeTitle("会话已恢复"), "Session resumed");
    assert.equal(noticeTitle("自定义提示"), "自定义提示");
    assert.equal(noticeTitle(undefined), undefined);
  });
});
