/**
 * Requirement splitter (M2) — turns a requirement text into TaskSpec[]
 * (design doc docs/multi-agent-orchestration-design.md §4.8 / §8-M2).
 *
 * The splitter runs a READ-ONLY researcher subagent with the structured
 * split prompt (§4.8). Each round's output is parsed into `TaskSpec[]`
 * and self-checked:
 *
 *   - every task carries a non-empty executable `acceptance[]`
 *   - `depends_on` is cycle-free and references known ids
 *   - total task count stays within `maxTasks` (default 8)
 *
 * A failed self-check feeds the issues back into the next round (max
 * `maxResplitRounds`, default 2); persistent failure throws so the caller
 * can surface the reason to a human.
 */

import { contentAsString } from "../../content.ts";
import type { ChatFn, LlmConfig } from "../../llm/index.ts";
import { createSubagentTool, researcherProfile } from "../../subagent/index.ts";
import type { SubagentArgs } from "../../subagent/types.ts";
import type { Tool, ToolProvider } from "../../tools/types.ts";
import type { ModelHint, PipelineLogEvent, TaskSpec } from "./types.ts";
import { topologicalBatches } from "./orchestrator.ts";

// ─── Options ─────────────────────────────────────────────────────────────────

export interface SplitOptions {
  /** LLM config the analyzer subagent inherits. */
  parentLlm: LlmConfig;
  /** Parent tool set; the researcher profile picks its read-only subset. */
  parentTools: ToolProvider;
  /** Inject a faux chat function for offline tests. */
  chat?: ChatFn;
  /** Model override for the analyzer subagent. */
  model?: string;
  /** Project background included in the split prompt. */
  projectContext?: string;
  /** Max tasks per spec set (design §4.8: default 8). */
  maxTasks?: number;
  /** Max re-split rounds when a self-check fails (default 2). */
  maxResplitRounds?: number;
  /** Hard timeout (ms) for the analyzer subagent. */
  timeout?: number;
  /** Cancellation signal. */
  signal?: AbortSignal;
  /** Emit split events (`split` on success, `fail` on per-round errors). */
  onEvent?: (event: PipelineLogEvent) => void;
}

/** Outcome of {@link analyzeRequirement}. */
export interface SplitResult {
  specs: TaskSpec[];
  /** Number of re-split rounds used (0 = first round was clean). */
  resplits: number;
  /** Raw analyzer text of the accepted round. */
  raw: string;
}

/** Default cap on tasks per spec set (design §4.8). */
export const DEFAULT_MAX_TASKS = 8;
/** Default number of re-split rounds after a failed self-check. */
export const DEFAULT_MAX_RESPLIT_ROUNDS = 2;

// ─── Prompt (design doc §4.8 template) ──────────────────────────────────────

/**
 * Build the structured split prompt. The analyzer MUST reply with a single
 * JSON array of TaskSpec elements — nothing else.
 */
export function buildSplitPrompt(
  requirement: string,
  projectContext: string,
  maxTasks: number,
  feedback?: string,
): string {
  const lines = [
    "You are the requirement analysis and task splitting module. Split the requirement into independently deliverable development tasks.",
    "",
    "## Input",
    `- Requirement text: ${requirement}`,
    `- Project background: ${projectContext || "(none provided)"}`,
    "",
    "## Splitting rules",
    "1. Granularity: one task = one worker in one coding session, about <=3 files.",
    "2. Independence: prefer mutually independent tasks; when a task truly depends on another, declare it in depends_on (task ids).",
    "3. Import safety: when a task creates a NEW importable module (a .ts/.js file that exports functions or values), its acceptance[] MUST include the clause: the module imports cleanly with no side effects — no top-level code runs on import, and any main-entry guard must be defensive (it must not crash when process.argv[1] is undefined, e.g. under `tsx -e`, bundlers, or test runners).",
    "4. Verifiable: every task's acceptance[] must be checkable item by item (test case / HTTP response / command output). Never just \"done\".",
    "5. files_hint: concrete workspace-relative paths; model_hint by complexity — \"light\" (simple CRUD/tests/formatting), \"standard\", \"flagship\" (cross-layer logic, new modules, refactors).",
    `6. Total tasks <= ${maxTasks}; if the requirement is too big, split the coarsest tasks finer.`,
    "7. Reply with ONLY a JSON array (no prose). Each element:",
    '{"id": "T-001", "title": "...", "context": "...", "instruction": "...", "acceptance": ["..."], "files_hint": ["..."], "depends_on": ["..."], "model_hint": "light"}',
  ];
  if (feedback !== undefined && feedback.length > 0) {
    lines.push("", "## Previous round failed self-check — fix ALL of these, then re-emit the full JSON array", feedback);
  }
  return lines.join("\n");
}

// ─── JSON extraction (last fenced block, then balanced-bracket scan) ────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Scan from a `[` for the matching `]`, honoring nested braces/brackets and strings. */
function scanBalancedArray(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

/**
 * Extract the LAST JSON array from free-form LLM text. Prefers the last
 * ```json fenced block that parses to an array; falls back to balanced-
 * bracket scanning where only regions that start OUTSIDE an already
 * accepted region count (so a nested `[1, 2]` inside the last top-level
 * array does not shadow it).
 */
export function extractLastJsonArray(text: string): unknown[] | undefined {
  const fences: string[] = [];
  for (const match of text.matchAll(/```[a-zA-Z0-9]*\s*\n?([\s\S]*?)```/g)) {
    const candidate = match[1]?.trim();
    if (candidate !== undefined && candidate.length > 0) fences.push(candidate);
  }
  for (let i = fences.length - 1; i >= 0; i -= 1) {
    const parsed = tryParse(fences[i]!);
    if (Array.isArray(parsed)) return parsed;
  }
  let last: unknown[] | undefined;
  let acceptedEnd = -1;
  let start = 0;
  while ((start = text.indexOf("[", start)) !== -1) {
    if (start > acceptedEnd) {
      const end = scanBalancedArray(text, start);
      if (end !== undefined) {
        const parsed = tryParse(text.slice(start, end + 1));
        if (Array.isArray(parsed)) {
          last = parsed;
          acceptedEnd = end;
        }
      }
    }
    start += 1;
  }
  return last;
}

// ─── Normalization & self-check ──────────────────────────────────────────────

const MODEL_HINTS: readonly ModelHint[] = ["light", "standard", "flagship"];
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Leniently coerce raw parsed objects into TaskSpecs. Leniency keeps the
 * re-split feedback loop usable; strictness lives in {@link validateSplit}.
 */
function normalizeSpecs(raw: unknown[]): TaskSpec[] {
  return raw.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`spec item ${index} is not an object`);
    }
    const id = str(item.id) ?? `T-${String(index + 1).padStart(2, "0")}`;
    const modelHint = str(item.model_hint);
    return {
      id,
      title: str(item.title) ?? id,
      context: str(item.context) ?? "",
      instruction: str(item.instruction) ?? "",
      acceptance: Array.isArray(item.acceptance) ? item.acceptance.map(String) : [],
      files_hint: Array.isArray(item.files_hint) ? item.files_hint.map(String) : [],
      ...(Array.isArray(item.depends_on)
        ? { depends_on: item.depends_on.map(String) }
        : {}),
      ...(modelHint !== undefined && MODEL_HINTS.includes(modelHint as ModelHint)
        ? { model_hint: modelHint as ModelHint }
        : {}),
    };
  });
}

/** Self-checks from design §4.8 (per-round, before dispatch). */
function validateSplit(specs: TaskSpec[], maxTasks: number): string[] {
  const issues: string[] = [];
  if (specs.length === 0) issues.push("no tasks produced");
  if (specs.length > maxTasks) {
    issues.push(`too many tasks (${specs.length} > ${maxTasks}) — split the coarsest tasks finer`);
  }
  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec.id)) issues.push(`duplicate task id: ${spec.id}`);
    seen.add(spec.id);
    if (spec.instruction.trim().length === 0) issues.push(`${spec.id}: empty instruction`);
    if (spec.acceptance.length === 0) issues.push(`${spec.id}: no executable acceptance criteria`);
  }
  try {
    topologicalBatches(specs);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  return issues;
}

// ─── Main entry ──────────────────────────────────────────────────────────────

/**
 * Analyze a requirement into TaskSpec[] (design §4.8): run the split prompt
 * through a read-only researcher subagent, parse the JSON array, and
 * self-check. Failed self-checks feed back into the next round, up to
 * `maxResplitRounds`; a persistent failure throws with the issues so the
 * orchestrator can surface them to a human.
 */
export async function analyzeRequirement(
  requirement: string,
  options: SplitOptions,
): Promise<SplitResult> {
  const tool = createSubagentTool({
    parentLlm: options.parentLlm,
    parentTools: options.parentTools,
    profiles: [researcherProfile],
    ...(options.chat !== undefined ? { chat: options.chat } : {}),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  const maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS;
  const maxRounds = Math.max(0, options.maxResplitRounds ?? DEFAULT_MAX_RESPLIT_ROUNDS);

  let feedback: string | undefined;
  for (let round = 0; round <= maxRounds; round += 1) {
    const prompt = buildSplitPrompt(requirement, options.projectContext ?? "", maxTasks, feedback);
    let raw: string;
    try {
      const toolResult = await tool.execute(
        { task: prompt, profile: "researcher", ...(options.model !== undefined ? { model: options.model } : {}) },
        options.signal,
      );
      raw = contentAsString(toolResult.content);
      if (toolResult.isError) {
        throw new Error(raw.slice(0, 300) || "analyzer subagent reported an error");
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      options.onEvent?.({ ts: new Date().toISOString(), task_id: "split", event: "fail", round, reason });
      if (round === maxRounds) throw new Error(`analyzer subagent failed: ${reason}`);
      feedback = `analyzer error: ${reason}`;
      continue;
    }

    let specs: TaskSpec[];
    try {
      const rawArray = extractLastJsonArray(raw);
      if (rawArray === undefined) {
        throw new Error("analyzer returned no parseable JSON array");
      }
      specs = normalizeSpecs(rawArray);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      options.onEvent?.({ ts: new Date().toISOString(), task_id: "split", event: "fail", round, reason });
      if (round === maxRounds) throw new Error(`unparseable split result: ${reason}`);
      feedback = reason;
      continue;
    }

    const issues = validateSplit(specs, maxTasks);
    if (issues.length === 0) {
      options.onEvent?.({
        ts: new Date().toISOString(),
        task_id: "split",
        event: "split",
        round: round + 1,
        tasks: specs.length,
      });
      return { specs, resplits: round, raw };
    }
    if (round === maxRounds) {
      options.onEvent?.({
        ts: new Date().toISOString(),
        task_id: "split",
        event: "fail",
        round: round + 1,
        reason: issues.join("; "),
      });
      throw new Error(`split self-check failed: ${issues.join("; ")}`);
    }
    feedback = issues.join("; ");
  }
  throw new Error("unreachable: split loop exited without result");
}
