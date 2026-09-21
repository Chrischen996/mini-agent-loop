import type { LlmConfig } from "./llm/config.ts";
import { clampThinkingLevelForModel, getThinkingLevelChoices } from "./think-intensity.ts";
import type { ModelThinkingLevel } from "./pi-ai/types.ts";

export type ThinkingMode = "fixed" | "adaptive";

export type ThinkingPolicyDecision = {
  level: ModelThinkingLevel;
  score: number;
  reasons: string[];
};

export type ThinkingPolicyToolResult = {
  name: string;
  isError?: boolean;
};

const READ_ONLY_REQUEST = /\b(explain|summari[sz]e|translate|list|show|what is|why)\b|解释|总结|翻译|查看|查询|列出/iu;
const CHANGE_REQUEST = /\b(implement|fix|debug|refactor|migrate|design|build|change|add)\b|实现|修复|调试|重构|迁移|设计|构建|修改|新增/iu;
const MULTI_STEP_REQUEST = /\b(and then|and also|across|multiple|end[- ]to[- ]end)\b|并且|同时|然后|多个|全链路/iu;
const VALIDATION_REQUEST = /\b(test|typecheck|lint|build|verify)\b|测试|类型检查|构建|验证/iu;
const HIGH_RISK_WORKFLOW = /\b(checkpoint|worktree|branch|session|fork|rewind|architecture)\b|检查点|工作树|分支|会话|架构/iu;

/** Resolve the default mode. Invalid values deliberately fall back to fixed. */
export function loadThinkingModeFromEnv(env: NodeJS.ProcessEnv = process.env): ThinkingMode {
  return env.MINI_AGENT_THINKING_MODE?.trim().toLowerCase() === "adaptive"
    ? "adaptive"
    : "fixed";
}

/**
 * Explainable first-turn policy. Scores are intentionally coarse: they are
 * stable enough to audit and can later be calibrated from actual outcomes.
 */
export function decideInitialThinkingLevel(input: {
  prompt: string;
  llm: LlmConfig;
  hasAttachments?: boolean;
}): ThinkingPolicyDecision {
  const prompt = input.prompt.trim();
  let score = 1;
  const reasons: string[] = ["baseline"];

  if (READ_ONLY_REQUEST.test(prompt)) { score -= 2; reasons.push("read_only_request"); }
  if (CHANGE_REQUEST.test(prompt)) { score += 2; reasons.push("change_request"); }
  if (MULTI_STEP_REQUEST.test(prompt)) { score += 1; reasons.push("multi_step_request"); }
  if (VALIDATION_REQUEST.test(prompt)) { score += 1; reasons.push("validation_request"); }
  if (HIGH_RISK_WORKFLOW.test(prompt)) { score += 1; reasons.push("workflow_complexity"); }
  if (input.hasAttachments) { score += 1; reasons.push("attachments"); }
  if (prompt.length > 700) { score += 1; reasons.push("long_prompt"); }
  if (prompt.length > 2_000) { score += 1; reasons.push("very_long_prompt"); }

  const requested = pickEffortForScore(getThinkingLevelChoices(input.llm), score);
  return {
    level: clampThinkingLevelForModel(input.llm, requested),
    score,
    reasons,
  };
}

function pickEffortForScore(choices: ModelThinkingLevel[], score: number): ModelThinkingLevel {
  const efforts = choices.filter((level) => level !== "off");
  if (efforts.length === 0) return "medium";

  const preferred: ModelThinkingLevel = score <= 0
    ? "low"
    : score <= 3
      ? "medium"
      : score <= 6
        ? "high"
        : efforts.at(-1)!;
  if (efforts.includes(preferred)) return preferred;

  if (score <= 0) return efforts[0]!;
  if (score <= 3) {
    const mediumIndex = efforts.findIndex((level) => level === "medium" || level === "high");
    return efforts[mediumIndex >= 0 ? mediumIndex : Math.min(1, efforts.length - 1)]!;
  }
  if (score <= 6) {
    const highIndex = efforts.findIndex((level) => level === "high" || level === "xhigh" || level === "max" || level === "ultra");
    return efforts[highIndex >= 0 ? highIndex : efforts.length - 1]!;
  }
  return efforts.at(-1)!;
}

/** Upgrade one available effort level after a meaningful failure; never downgrade. */
export function decideNextThinkingLevel(input: {
  llm: LlmConfig;
  currentLevel: ModelThinkingLevel;
  toolResults: ThinkingPolicyToolResult[];
  escalationCount: number;
  maxEscalations?: number;
}): ThinkingPolicyDecision | undefined {
  const limit = input.maxEscalations ?? 2;
  if (input.escalationCount >= limit) return undefined;
  const failed = input.toolResults.filter((result) => result.isError);
  if (failed.length === 0) return undefined;

  const validationFailed = failed.some((result) => result.name === "validate_workspace");
  const choices = getThinkingLevelChoices(input.llm);
  const currentIndex = choices.indexOf(clampThinkingLevelForModel(input.llm, input.currentLevel));
  const next = choices[Math.min(choices.length - 1, Math.max(0, currentIndex) + 1)];
  if (!next || next === input.currentLevel) return undefined;

  return {
    level: next,
    score: validationFailed ? 2 : 1,
    reasons: validationFailed
      ? ["validation_failure"]
      : failed.length > 1
        ? ["multiple_tool_failures"]
        : ["tool_failure"],
  };
}
