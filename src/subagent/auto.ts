/** Configuration for the optional code-level subagent preflight. */
export type AutoSubagentOptions = {
  /** Enable the preflight. Undefined/false keeps the existing LLM-only flow. */
  enabled?: boolean;
  /** Minimum explainable score required before delegating. Default: 2. */
  minScore?: number;
  /**
   * Profile passed to the subagent tool.
   * When omitted, the decision layer picks researcher/coder/reviewer from the prompt.
   */
  profile?: string;
  /** Optional model override passed to the subagent tool. */
  model?: string;
  /** Optional max-turn override passed to the subagent tool. */
  maxTurns?: number;
  /** Allow the automatic preflight to select a write-capable profile. */
  allowWrites?: boolean;
  /**
   * When true (default if enabled), the parent stays in coordinator mode for
   * complex tasks: stronger orchestration prompt + limited direct exploration.
   */
  coordinatorMode?: boolean;
  /**
   * Max direct exploration tool calls (read/grep/find/ls/codebase_*) the parent
   * may make while coordinator mode is active before it must use subagent again.
   * Default: 2. Set 0 to force subagent-only exploration after activation.
   */
  maxDirectExploration?: number;
};

export type AutoSubagentDecision = {
  shouldDelegate: boolean;
  /** Whether the parent should act as an orchestrator for this request. */
  coordinatorMode: boolean;
  score: number;
  reasons: string[];
  profile: string;
  /**
   * Focused task text for the preflight subagent.
   * Narrower than the raw user prompt so the child is more likely to finish
   * with a usable answer inside its turn budget.
   */
  task: string;
};

/** Default threshold lowered so common implement/analyze prompts still preflight. */
export const DEFAULT_MIN_SCORE = 2;
export const DEFAULT_MAX_DIRECT_EXPLORATION = 2;

/** Parent-side tools treated as "doing the research yourself". */
export const EXPLORATION_TOOL_NAMES = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "codebase_open",
  "codebase_search",
  "codebase_read",
  "codebase_explain",
]);

/** Tools that count as proper delegation. */
export const DELEGATION_TOOL_NAMES = new Set([
  "subagent",
  "subagent_batch",
]);

const MULTI_STEP_PATTERN =
  /(?:先|然后|接着|最后|步骤|分别|同时|并且|以及|对比|比较|first|then|next|finally|steps?|compare|multiple|and then|implement|create|build|develop)/i;
const CODE_PATTERN =
  /(?:代码|源码|仓库|项目|模块|文件|目录|接口|测试|实现|修改|重构|review|debug|fix|implement|refactor|code|repository|module|file|test|feature|component|api|endpoint)/i;
const INVESTIGATION_PATTERN =
  /(?:分析|调查|排查|梳理|总结|审查|检查|解释|研究|analy[sz]e|investigate|review|inspect|explain|research|trace|summarize|overview)/i;
const EXPLICIT_DELEGATION_PATTERN =
  /(?:子\s*agent|子代理|sub[- ]?agent|delegate|委托|delegat(?:e|ion))/i;
// Strong signals: tasks that clearly benefit from parallel or specialized delegation
const COMPLEX_TASK_PATTERN =
  /(?:多个|多种|一批|several|multiple files|multiple tests|batch|parallel|concurrent)/i;
// Code files present in the prompt → likely a coding task
const FILE_PATH_PATTERN = /\w+\.(ts|tsx|js|jsx|py|go|rs|md|json|yaml|yml|css|html)\b/;
const WRITE_PATTERN =
  /(?:实现|修改|重构|修复|添加|新增|编写|创建|改代码|修 bug|fix|implement|refactor|add(?:\s+\w+)?|create|write|edit|update|patch)/i;
const REVIEW_PATTERN =
  /(?:代码审查|审查|评审|audit|code review|\breview\b)/i;
const DEEP_SCOPE_PATTERN =
  /(?:整个|全量|全面|架构|结构|codebase|repository|workspace|多文件|多个文件|多个模块|several files|multiple files|across (?:the )?codebase)/i;
const WEB_RESEARCH_PATTERN =
  /(?:搜索|查一下|联网|最新|web search|search the web|look up|google)/i;
const SIMPLE_TASK_PATTERN =
  /^(?:读一下|看看|打开|cat |read |ls |list |what is|多少|是什么)\b/i;

function readInt(value: string | undefined, minimum: number): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : undefined;
}

function readBool(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function inferProfile(text: string): string {
  const wantsReview = REVIEW_PATTERN.test(text);
  const wantsWrite = WRITE_PATTERN.test(text);
  // Pure review/audit work should not pick the coder profile.
  if (wantsReview && !wantsWrite) return "reviewer";
  if (wantsWrite) return "coder";
  if (WEB_RESEARCH_PATTERN.test(text) && !CODE_PATTERN.test(text)) return "researcher";
  return "researcher";
}

/**
 * Score a user request using deliberately simple, inspectable signals.
 * This is a preflight policy, not a replacement for the model's own tool choice.
 */
export function decideAutoSubagent(
  userText: string,
  options: Pick<AutoSubagentOptions, "minScore" | "profile" | "coordinatorMode" | "allowWrites"> = {},
): AutoSubagentDecision {
  const text = userText.trim();
  const reasons: string[] = [];
  let score = 0;

  if (text.length === 0) {
    return {
      shouldDelegate: false,
      coordinatorMode: false,
      score: 0,
      reasons: [],
      profile: options.profile ?? "researcher",
      task: "",
    };
  }

  const hasMultiStep = MULTI_STEP_PATTERN.test(text);
  const hasCode = CODE_PATTERN.test(text);
  const hasInvestigation = INVESTIGATION_PATTERN.test(text);
  const hasWrite = WRITE_PATTERN.test(text);
  const hasDeepScope = DEEP_SCOPE_PATTERN.test(text);
  const hasWeb = WEB_RESEARCH_PATTERN.test(text);
  const hasComplex = COMPLEX_TASK_PATTERN.test(text);
  const hasFilePath = FILE_PATH_PATTERN.test(text);
  const explicitDelegation = EXPLICIT_DELEGATION_PATTERN.test(text);
  const looksSimple =
    text.length < 80 &&
    SIMPLE_TASK_PATTERN.test(text) &&
    !hasMultiStep &&
    !hasDeepScope &&
    !hasComplex &&
    !hasFilePath &&
    !explicitDelegation;

  if (text.length >= 500) {
    score += 1;
    reasons.push("long prompt");
  }
  if (hasMultiStep) {
    score += 1;
    reasons.push("multi-step request");
  }
  if (hasCode) {
    score += 1;
    reasons.push("code/workspace context");
  }
  if (hasInvestigation) {
    score += 1;
    reasons.push("investigation or review task");
  }
  if (hasWrite) {
    score += 1;
    reasons.push("code change task");
  }
  if (hasDeepScope) {
    score += 1;
    reasons.push("deep or multi-file scope");
  }
  if (hasWeb) {
    score += 1;
    reasons.push("web research task");
  }
  if (hasComplex) {
    score += 2;
    reasons.push("complex/parallel task signal");
  }
  if (hasFilePath) {
    score += 1;
    reasons.push("code file paths in prompt");
  }
  // Combined workspace work is more than the sum of isolated keywords.
  if (hasCode && hasInvestigation) {
    score += 1;
    reasons.push("workspace investigation");
  }
  if (hasCode && hasWrite) {
    score += 1;
    reasons.push("workspace code change");
  }
  if (explicitDelegation) {
    score += 2;
    reasons.push("explicit delegation signal");
  }
  if (looksSimple) {
    score = Math.max(0, score - 2);
    reasons.push("simple single-step task");
  }

  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const requestedProfile = options.profile ?? inferProfile(text);
  const profile = !options.allowWrites && requestedProfile === "coder"
    ? "researcher"
    : requestedProfile;
  const shouldDelegate =
    !looksSimple && (explicitDelegation || score >= minScore);
  const coordinatorEnabled = options.coordinatorMode !== false;
  const coordinatorMode = coordinatorEnabled && shouldDelegate;

  // Keep profile reason visible for observability when we actually plan to run.
  if (shouldDelegate && !options.profile) {
    reasons.push(`profile:${profile}`);
  }
  if (requestedProfile !== profile) {
    reasons.push("write-capable auto profile downgraded to researcher");
  }
  if (coordinatorMode) {
    reasons.push("coordinator mode");
  }

  return {
    shouldDelegate,
    coordinatorMode,
    score,
    reasons,
    profile,
    task: shouldDelegate ? buildPreflightTask(text, profile) : text,
  };
}

/**
 * Build a focused preflight task for the chosen profile.
 * Keep the original user request, but constrain the child to a completable goal
 * so it is less likely to exhaust maxTurns without a final answer.
 */
export function buildPreflightTask(userText: string, profile: string): string {
  const clipped =
    userText.length > 1200 ? `${userText.slice(0, 1200).trim()}…` : userText.trim();

  if (profile === "coder") {
    return [
      "You are the coder subagent for a parent orchestrator.",
      "Focus only on implementation-related progress for this request.",
      "Do the minimum code changes needed, or if more context is required, inspect only the directly relevant files.",
      "Do not run broad repository-wide exploration.",
      "Finish with a plain-text summary of files changed and remaining work.",
      "",
      "User request:",
      clipped,
    ].join("\n");
  }

  if (profile === "reviewer") {
    return [
      "You are the reviewer subagent for a parent orchestrator.",
      "Focus on code review findings for this request.",
      "Inspect the most relevant files only; avoid exhaustive repo walks.",
      "Finish with a plain-text review summary: critical issues, warnings, and suggestions.",
      "",
      "User request:",
      clipped,
    ].join("\n");
  }

  return [
    "You are the researcher subagent for a parent orchestrator.",
    "Gather only the key facts needed for the parent to continue.",
    "Prefer targeted read/grep/find over broad exploration.",
    "If the full request is large, cover the highest-signal parts first.",
    "Finish with a plain-text findings summary the parent can act on.",
    "Do not implement code changes.",
    "",
    "User request:",
    clipped,
  ].join("\n");
}

/** Build the system-prompt fragment injected while coordinator mode is active. */
export function buildCoordinatorPromptFragment(input: {
  profile: string;
  preflightExecuted: boolean;
  maxDirectExploration: number;
}): string {
  const budget =
    input.maxDirectExploration <= 0
      ? "No direct exploration — always delegate."
      : `At most ${input.maxDirectExploration} direct exploration calls (read/grep/find/ls/codebase_*), then delegate.`;

  const preflightLine = input.preflightExecuted
    ? `A ${input.profile} preflight already ran — prefer its findings.`
    : `Prefer spawning a ${input.profile} subagent before deep exploration.`;

  return [
    "### Coordinator Mode",
    "You are the orchestrator. Delegate multi-file work to subagent/subagent_batch.",
    preflightLine,
    budget,
    "Use subagent_batch for independent parallel work.",
  ].join("\n");
}

/**
 * Load the auto-subagent policy used by CLI, TUI, and the HTTP server.
 *
 * Default is **enabled** (opt-out). Set `MINI_AGENT_AUTO_SUBAGENT=0|false|off`
 * to restore the pure LLM-only delegation flow.
 */
export function loadAutoSubagentOptionsFromEnv(): AutoSubagentOptions | undefined {
  const raw = process.env.MINI_AGENT_AUTO_SUBAGENT?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") {
    return undefined;
  }

  const minScore = readInt(process.env.MINI_AGENT_AUTO_SUBAGENT_MIN_SCORE, 0);
  const maxTurns = readInt(process.env.MINI_AGENT_AUTO_SUBAGENT_MAX_TURNS, 1);
  const maxDirectExploration = readInt(process.env.MINI_AGENT_MAX_DIRECT_EXPLORATION, 0);
  const coordinatorMode = readBool(process.env.MINI_AGENT_COORDINATOR_MODE);
  const profile = process.env.MINI_AGENT_AUTO_SUBAGENT_PROFILE?.trim() || undefined;
  const model = process.env.MINI_AGENT_AUTO_SUBAGENT_MODEL?.trim() || undefined;
  const allowWrites = readBool(process.env.MINI_AGENT_AUTO_SUBAGENT_ALLOW_WRITES);

  return {
    enabled: true,
    ...(minScore !== undefined ? { minScore } : {}),
    ...(maxTurns ? { maxTurns } : {}),
    ...(maxDirectExploration !== undefined ? { maxDirectExploration } : {}),
    ...(coordinatorMode !== undefined ? { coordinatorMode } : {}),
    ...(profile ? { profile } : {}),
    ...(model ? { model } : {}),
    ...(allowWrites === true ? { allowWrites: true } : {}),
  };
}
