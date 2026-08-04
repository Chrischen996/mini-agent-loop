/** Configuration for the optional code-level subagent preflight. */
export type AutoSubagentOptions = {
  /** Enable the preflight. Undefined/false keeps the existing LLM-only flow. */
  enabled?: boolean;
  /** Minimum explainable score required before delegating. Default: 3. */
  minScore?: number;
  /** Profile passed to the subagent tool. Default: "researcher". */
  profile?: string;
  /** Optional model override passed to the subagent tool. */
  model?: string;
  /** Optional max-turn override passed to the subagent tool. */
  maxTurns?: number;
};

export type AutoSubagentDecision = {
  shouldDelegate: boolean;
  score: number;
  reasons: string[];
  profile: string;
};

const DEFAULT_MIN_SCORE = 3;

const MULTI_STEP_PATTERN =
  /(?:先|然后|接着|最后|步骤|分别|同时|并且|以及|对比|比较|first|then|next|finally|steps?|compare|multiple|and then)/i;
const CODE_PATTERN =
  /(?:代码|源码|仓库|项目|模块|文件|目录|接口|测试|实现|修改|重构|review|debug|fix|implement|refactor|code|repository|module|file|test)/i;
const INVESTIGATION_PATTERN =
  /(?:分析|调查|排查|梳理|总结|审查|检查|解释|研究|analy[sz]e|investigate|review|inspect|explain|research|trace)/i;
const EXPLICIT_DELEGATION_PATTERN =
  /(?:子\s*agent|子代理|sub[- ]?agent|delegate|委托|delegat(?:e|ion))/i;

function readInt(value: string | undefined, minimum: number): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : undefined;
}

/**
 * Score a user request using deliberately simple, inspectable signals.
 * This is a preflight policy, not a replacement for the model's own tool choice.
 */
export function decideAutoSubagent(
  userText: string,
  options: Pick<AutoSubagentOptions, "minScore" | "profile"> = {},
): AutoSubagentDecision {
  const text = userText.trim();
  const reasons: string[] = [];
  let score = 0;

  if (text.length >= 500) {
    score += 1;
    reasons.push("long prompt");
  }
  if (MULTI_STEP_PATTERN.test(text)) {
    score += 1;
    reasons.push("multi-step request");
  }
  if (CODE_PATTERN.test(text)) {
    score += 1;
    reasons.push("code/workspace context");
  }
  if (INVESTIGATION_PATTERN.test(text)) {
    score += 1;
    reasons.push("investigation or review task");
  }
  const explicitDelegation = EXPLICIT_DELEGATION_PATTERN.test(text);
  if (explicitDelegation) {
    score += 2;
    reasons.push("explicit delegation signal");
  }
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  return {
    shouldDelegate: text.length > 0 && (explicitDelegation || score >= minScore),
    score,
    reasons,
    profile: options.profile ?? "researcher",
  };
}

/** Load the opt-in policy used by CLI, TUI, and the HTTP server. */
export function loadAutoSubagentOptionsFromEnv(): AutoSubagentOptions | undefined {
  if (process.env.MINI_AGENT_AUTO_SUBAGENT !== "1") return undefined;

  const minScore = readInt(process.env.MINI_AGENT_AUTO_SUBAGENT_MIN_SCORE, 0);
  const maxTurns = readInt(process.env.MINI_AGENT_AUTO_SUBAGENT_MAX_TURNS, 1);
  const profile = process.env.MINI_AGENT_AUTO_SUBAGENT_PROFILE?.trim() || undefined;
  const model = process.env.MINI_AGENT_AUTO_SUBAGENT_MODEL?.trim() || undefined;

  return {
    enabled: true,
    ...(minScore !== undefined ? { minScore } : {}),
    ...(maxTurns ? { maxTurns } : {}),
    ...(profile ? { profile } : {}),
    ...(model ? { model } : {}),
  };
}
