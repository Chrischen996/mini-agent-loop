/**
 * Plan formatter — parses agent plan output into structured summary.
 * Extracts numbered/bulleted steps, file paths, and action types.
 */

export type PlanStep = {
  index: number;
  text: string;
  files?: string[];
  tool?: string; // "read" | "write" | "edit" | "bash" | "subagent"
};

export type PlanSummary = {
  /** Original prompt that generated this plan */
  prompt: string;
  /** Total number of steps extracted */
  stepCount: number;
  /** Structured steps with optional file/tool annotations */
  steps: PlanStep[];
  /** All file paths mentioned in the plan */
  files: string[];
  /** Unique action types referenced */
  actions: string[];
  /** Full original plan text (unmodified) */
  raw: string;
};

/**
 * Recognized keywords that indicate a specific tool/action type.
 */
const TOOL_KEYWORDS: Record<string, string[]> = {
  read: ["read", "查看", "检查", "了解", "分析", "grep", "find"],
  write: ["write", "创建", "新建", "新增", "生成", "新建文件"],
  edit: ["edit", "修改", "更新", "重构", "替换", "改动", "patch"],
  bash: ["bash", "shell", "run", "执行", "npm", "npx", "node", "yarn", "test", "build", "lint"],
  subagent: ["delegate", "subagent", "spawn", "并行"],
};

/**
 * Extract file paths from a plan line (matches .ts/.js/.py etc. paths).
 */
function extractFiles(text: string): string[] {
  const matches = text.match(/[\w./-]+\.(?:tsx?|jsx?|yaml|yml|json|py|go|rs|md|css|html)\b/g) || [];
  return Array.from(new Set(matches));
}

/**
 * Detect which tool/action type a plan step likely involves.
 */
function detectTool(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const [tool, keywords] of Object.entries(TOOL_KEYWORDS)) {
    if (keywords.some((k) => lower.includes(k))) return tool;
  }
  return undefined;
}

/**
 * Parse a plan text block into a structured PlanSummary.
 * Handles both numbered lists (1., 2., ...) and bullet lists (-, *, •).
 */
export function parsePlan(prompt: string, rawPlan: string): PlanSummary {
  const lines = rawPlan.split("\n");
  const steps: PlanStep[] = [];
  const allFiles: string[] = [];
  const allActions: string[] = [];
  let stepIndex = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    // Match numbered steps: "1.", "1)", "(1)", "Step 1:"
    const numMatch = trimmed.match(/^(?:\d+\.|\(\d+\)|Step\s+\d+:)\s*(.*)/i);
    // Match bullet steps: "- ", "* ", "• "
    const bulletMatch = trimmed.match(/^[-*•]\s+(.*)/);

    const match = numMatch || bulletMatch;
    if (!match) continue;

    const text = match[1]!;
    const files = extractFiles(text);
    const tool = detectTool(text);

    if (files.length > 0) allFiles.push(...files);
    if (tool) allActions.push(tool);

    steps.push({ index: ++stepIndex, text, files, tool });
  }

  // Also collect files from the full raw text that weren't captured in steps
  const allFileMatches = rawPlan.match(/[\w./-]+\.(?:tsx?|jsx?|yaml|yml|json|py|go|rs|md|css|html)\b/g) || [];
  for (const f of allFileMatches) {
    if (!allFiles.includes(f)) allFiles.push(f);
  }

  return {
    prompt,
    stepCount: steps.length,
    steps,
    files: Array.from(new Set(allFiles)),
    actions: Array.from(new Set(allActions)),
    raw: rawPlan,
  };
}

/**
 * Render a PlanSummary as a human-readable console preview.
 */
export function formatPlanPreview(summary: PlanSummary): string {
  const lines: string[] = [];
  lines.push("═".repeat(60));
  lines.push(`  📋 PLAN: ${summary.prompt.slice(0, 60)}${summary.prompt.length > 60 ? "…" : ""}`);
  lines.push("═".repeat(60));
  lines.push("");

  // Actions summary
  if (summary.actions.length > 0) {
    const actionLabels: Record<string, string> = {
      read: "📖 Read",
      write: "✏️ Write",
      edit: "🔧 Edit",
      bash: "⚡ Bash",
      subagent: "🤖 Delegate",
    };
    lines.push(`  Actions: ${summary.actions.map((a) => actionLabels[a] ?? a).join(" · ")}`);
  }

  // Files summary
  if (summary.files.length > 0) {
    lines.push(`  Files (${summary.files.length}): ${summary.files.join(", ")}`);
  }

  lines.push("");
  lines.push("── Steps ──");

  for (const step of summary.steps) {
    const icon = step.tool ? { read: "📖", write: "✏️", edit: "🔧", bash: "⚡", subagent: "🤖" }[step.tool] ?? "·" : "·";
    lines.push(`  ${icon} ${step.index}. ${step.text}`);
    if (step.files?.length) {
      lines.push(`      → ${step.files.join(", ")}`);
    }
  }

  lines.push("");
  lines.push("─".repeat(60));
  return lines.join("\n");
}
