import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { statusLabel } from "../src/tui/claude-style.ts";

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
});
