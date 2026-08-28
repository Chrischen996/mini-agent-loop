import type { PermissionMode, PermissionRisk } from "../permissions.ts";

/** Human-facing labels used by both the ANSI and Ink presentation paths. */
export function permissionModeLabel(mode: PermissionMode): string {
  switch (mode) {
    case "plan": return "Plan mode";
    case "approval": return "Default permissions";
    case "bypass": return "Bypass permissions";
  }
}

export function permissionRiskLabel(risk: PermissionRisk): string {
  switch (risk) {
    case "safe": return "Low risk";
    case "medium": return "Medium risk";
    case "high": return "High risk";
  }
}

export function thinkingLevelLabel(value: string): string {
  const labels: Record<string, string> = {
    关闭: "off",
    最小: "minimal",
    低: "low",
    中: "medium",
    高: "high",
    极高: "xhigh",
    最大: "max",
    超限: "ultra",
  };
  return labels[value] ?? value;
}

/** Keep provider-specific status strings out of the visible Claude-style UI. */
export function statusLabel(status: string, busy = false): string {
  const value = status.trim();
  if (!value || value === "就绪") return busy ? "Working…" : "Ready";
  if (/计划.*审批|待审批|plan.*review|pending.*approval/i.test(value)) return "Plan ready for review";
  if (/权限模式/i.test(value)) {
    if (/计划/.test(value)) return "Plan mode";
    if (/审批|默认/.test(value)) return "Default permissions";
    if (/绕过/.test(value)) return "Bypass permissions";
  }
  if (/权限|permission|授权/i.test(value)) return "Waiting for permission";
  if (/重试|retry|连接中断|超时/i.test(value)) return "Retrying…";
  if (/思考|thinking|规划|planning|思考强度|自适应思考/i.test(value)) return "Thinking…";
  if (/执行工具|执行计划|整理回复|请求模型|输出|生成|模型输出|stream/i.test(value)) return "Working…";
  if (/任务列表|todo/i.test(value)) return "Updating todos…";
  if (/自动续跑|续跑|continu/i.test(value)) return "Continuing…";
  if (/子代理.*完成|sub.?agent.*done|delegat.*done/i.test(value)) return "Done";
  if (/子代理.*失败|sub.?agent.*fail|delegat.*fail/i.test(value)) return "Failed";
  if (/子代理|子.?agent|编排模式|delegat|orchestrat/i.test(value)) return "Delegating…";
  if (/上下文.*压缩|context.*compact/i.test(value)) return "Context compacted";
  if (/会话.*恢复|恢复会话|session.*resum/i.test(value)) return "Session resumed";
  if (/取消|中止|停止|已停止|cancel|abort|stop/i.test(value)) return "Cancelled";
  if (/失败|错误|error|fail/i.test(value)) return "Failed";
  if (/完成|成功|批准|已批准|done|success|complete/i.test(value)) return "Done";
  // Keep useful ASCII diagnostics, but never leak the old project-specific
  // Chinese status strings into the Claude-style chrome.
  return /[\u3400-\u9fff]/.test(value) ? (busy ? "Working…" : "Ready") : value;
}

/** Translate internal control notices at the presentation boundary. */
export function noticeTitle(title?: string): string | undefined {
  if (!title) return undefined;
  const labels: Array<[RegExp, string]> = [
    [/会话.*恢复|恢复会话/, "Session resumed"],
    [/可用命令/, "Available commands"],
    [/正在执行/, "Working"],
    [/已复制/, "Copied to clipboard"],
    [/复制失败/, "Copy failed"],
    [/复制/, "Clipboard"],
    [/上下文统计/, "Context usage"],
    [/配置文件/, "Model profiles"],
    [/模型已切换/, "Model switched"],
    [/模型切换失败/, "Model switch failed"],
    [/计划/, "Plan"],
    [/记忆/, "Memory"],
  ];
  for (const [pattern, label] of labels) if (pattern.test(title)) return label;
  return /[\u3400-\u9fff]/.test(title) ? "Notice" : title;
}

export function noticeText(text: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/条消息/g, "messages"],
    [/条记录/g, "records"],
    [/上下文:\s*(\d+) tokens · 本轮输出:\s*(\d+) tokens/g, "Context: $1 tokens · This turn: $2 tokens"],
    [/当前没有保存的计划。使用 \/plan <任务> 生成。/g, "No saved plan. Use /plan <task> to generate one."],
    [/用法: \/plan <任务>/g, "Usage: /plan <task>"],
    [/尚无归档计划。/g, "No archived plans."],
    [/无已保存的配置文件/g, "No saved profiles"],
    [/当前 turn 完成后再切换模型或配置文件。普通消息仍会排队。/g, "The current turn is still running. Messages will be queued."],
    [/当前 turn 完成后才能执行该控制命令。普通消息会排队。/g, "This control command will run after the current turn. Messages will be queued."],
    [/没有可恢复的会话。/g, "No saved sessions."],
    [/没有可复制的原文。/g, "There is no transcript to copy."],
    [/可用/g, "Available"],
    [/已删除配置文件/g, "Deleted profile"],
    [/已添加图片/g, "Attached image"],
    [/无法添加图片/g, "Unable to attach image"],
  ];
  let result = text;
  for (const [pattern, replacement] of replacements) result = result.replace(pattern, replacement);
  return /[\u3400-\u9fff]/.test(result) ? result.replace(/[\u3400-\u9fff][^\n]*/g, "") : result;
}

function short(value: string, max = 96): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Compact argument text matching Claude Code's inline tool-use summary. */
export function toolArgumentSummary(name: string, args: Record<string, unknown>, fallback?: string): string {
  const command = ["command", "cmd", "input"].map((key) => args[key]).find((value): value is string => typeof value === "string" && Boolean(value.trim()));
  if (command) return `$ ${short(command)}`;
  const target = ["path", "file", "pattern", "query", "url", "source", "destination"].map((key) => args[key]).find((value): value is string => typeof value === "string" && Boolean(value.trim()));
  if (target) return short(target);
  const entries = Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .slice(0, 2)
    .map(([key, value]) => `${key}=${typeof value === "string" ? short(value, 36) : short(JSON.stringify(value), 36)}`);
  if (entries.length) return entries.join(", ");
  if (fallback) {
    try {
      const parsed = JSON.parse(fallback) as Record<string, unknown>;
      return toolArgumentSummary(name, parsed);
    } catch {
      // Keep malformed provider arguments out of the card rather than showing
      // a large JSON blob next to the tool name.
    }
  }
  return "";
}
