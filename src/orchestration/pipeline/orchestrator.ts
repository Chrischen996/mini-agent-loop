/**
 * Pipeline orchestrator (M1) — Route A: in-process subagent dispatch.
 *
 * Implements the orchestrator → worker → callback → acceptance loop from
 * docs/multi-agent-orchestration-design.md:
 *
 * - §4  — orchestrator design: `dispatch(spec)` spawns a `coder` subagent,
 *         the subagent's structured JSON reply is the "callback"
 *         (`WorkerResult`), topological batch dispatch honors `depends_on`,
 *         `model_hint` is mapped to a concrete model id.
 * - §6  — acceptance pipeline: status gate → file-scope gate → optional
 *         `validate` gate → independent `reviewer` subagent verdict.
 * - §7  — iteration loop: failed review re-dispatches a revision spec with
 *         the failed items/suggestions appended to the instruction, up to
 *         `maxIter` times; exhaustion marks the task `failed`.
 *
 * M1 scope: serial dispatch within a batch (parallelism via
 * `subagent_batch` is a documented M3 extension point, design §4.2/§8).
 *
 * The subagent tool is created once per orchestrator and shared by worker
 * and reviewer dispatches, so a single injected faux `chat` can drive the
 * whole pipeline offline. Reviewer prompts carry {@link REVIEW_VERDICT_MARKER}
 * so an injected chat can distinguish reviewer calls from worker calls.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { contentAsString } from "../../content.ts";
import type { ChatFn, LlmConfig } from "../../llm/index.ts";
import { createSubagentTool, defaultProfiles } from "../../subagent/index.ts";
import type { SubagentArgs } from "../../subagent/types.ts";
import { resolveToolProvider, type Tool, type ToolProvider } from "../../tools/types.ts";
import type {
  ModelHint,
  PipelineEventName,
  PipelineLogEvent,
  ReviewVerdict,
  TaskSpec,
  WorkerResult,
} from "./types.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default max turns for worker subagent dispatches. */
export const DEFAULT_WORKER_MAX_TURNS = 12;
/** Default dispatch→review iterations before a task is marked failed. */
export const DEFAULT_MAX_ITER = 3;
/** Steps run when the `validate_workspace` tool is auto-discovered. */
export const DEFAULT_VALIDATION_STEPS: Array<"test" | "typecheck" | "build"> = [
  "test",
  "typecheck",
  "build",
];

/**
 * Unique marker embedded in every reviewer prompt. A single injected faux
 * chat serving both worker and reviewer subagents can branch on this string
 * in the message content.
 */
export const REVIEW_VERDICT_MARKER = "REVIEW VERDICT";

// ─── Options & outcomes ─────────────────────────────────────────────────────

/** Options for the {@link PipelineOrchestrator} constructor. */
export interface PipelineOrchestratorOptions {
  /** LLM config the worker/reviewer subagents inherit. */
  parentLlm: LlmConfig;
  /** Parent tool set; subagents pick their profile's tool subset from it. */
  parentTools: ToolProvider;
  /** Inject a faux chat function for offline tests (shared by worker + reviewer). */
  chat?: ChatFn;
  /** Map model_hint → concrete model id (design doc §4.6). */
  modelMapping?: Partial<Record<ModelHint, string>>;
  /** Max turns for worker subagent dispatches. Default 12. */
  workerMaxTurns?: number;
  /**
   * Per-role LLM configs: the researcher (H3 planner), coder (worker) and
   * reviewer (H4) subagents honor /multi-agent role bindings through this map
   * (researcher / coder / reviewer → LlmConfig), falling back to parentLlm when
   * a role is absent. Priority: args.model > profile.llm > roleLlmConfigs[role] > parentLlm.
   */
  roleLlmConfigs?: Record<string, LlmConfig>;
  /**
   * Within-wave parallelism (M3): how many tasks of one planned wave may
   * run concurrently. Default 1 (M1 serial behavior). Waves always run
   * sequentially; parallelism only applies inside a wave.
   */
  maxConcurrency?: number;
  /** Emit pipeline log events (design doc §5.8 event names). */
  onEvent?: (event: PipelineLogEvent) => void;
  /** Workspace root for changed-file existence checks (default process.cwd()). */
  workspaceRoot?: string;
  /** Optional hard gate: run validation (test/typecheck/build) before the reviewer. */
  validate?: () => Promise<{ ok: boolean; report: string }>;
  /** Steps used when the `validate_workspace` tool is auto-discovered. Default: all three. */
  validationSteps?: Array<"test" | "typecheck" | "build">;
  /** Directory for per-task JSONL event logs (`{task_id}.jsonl`, design doc §5.8). Omit to skip file logging. */
  logDir?: string;
  /** Capture a `git_checkpoint` before accepting a passing task (auto when the tool is available). Set false to disable. */
  captureCheckpoint?: boolean;
  /** Disable the reviewer subagent gate (status/scope/validate gates still run). */
  skipReviewer?: boolean;
  /**
   * Enable the built-in import-safety gate (§6.2 hardening): every
   * importable module in `changed_files` is probed with a bare dynamic
   * import in a child process (`tsxImportProbe`, `npx tsx -e`). A crash
   * fails the review (e.g. a non-defensive main-entry guard).
   */
  importSafety?: boolean;
  /**
   * Custom import-safety probe (takes precedence over `importSafety`):
   * called once per importable changed file; a not-ok result fails the
   * review with the detail attached to the failed item.
   */
  importSafetyProbe?: (file: string) => Promise<{ ok: boolean; detail?: string }>;
  /** Hard timeout (ms) for subagent execution. */
  timeout?: number;
  /** Cancellation signal propagated to subagents. */
  signal?: AbortSignal;
  /**
   * Per-worker subagent token budget (cost control, design doc §9): each
   * worker dispatch is force-stopped when its accumulated usage exceeds
   * this limit. Omit for unlimited.
   */
  workerTokenBudget?: number;
  /** Per-reviewer subagent token budget. Omit for unlimited. */
  reviewerTokenBudget?: number;
  /**
   * Replace the built-in reviewer subagent (gate 4) with a custom function,
   * e.g. one built from `review-engine.ts`'s `reviewAndMerge` for external
   * verdicts. Receives the worker result and spec, returns the verdict.
   *
   * Contract:
   *  - `passed: false` with an empty `failed_items` array is treated as a
   *    failure (the orchestrator fills in a generic item so the retry loop
   *    has actionable feedback); callers SHOULD list the concrete failures.
   *  - Throwing exceptions are caught and converted into a failed verdict
   *    (`"external reviewer failed: …"`), so a flaky external reviewer can
   *    never break the whole pipeline.
   */
  externalReviewer?: (result: WorkerResult, spec: TaskSpec) => Promise<ReviewVerdict> | ReviewVerdict;
  /**
   * Global token budget shared across every worker/reviewer dispatch of
   * this orchestrator (and any sub-subagents they spawn). When a dispatch
   * would exceed it, the subagent tool refuses to start and the task is
   * reported as `failed` (design doc §9 cost control).
   */
  globalTokenBudget?: number;
  /** Forward raw subagent lifecycle events (start/end/budget warnings) for observability. */
  onSubagentEvent?: (event: import("../../subagent/types.ts").SubagentEvent) => void;
}

/** Options for {@link PipelineOrchestrator.run}. */
export interface RunOptions {
  /** Max dispatch→review iterations per task. Default 3. */
  maxIter?: number;
  /**
   * Cancellation signal applied for the duration of this run. When provided,
   * in-flight subagent dispatches are aborted as soon as the signal fires;
   * tasks not yet dispatched are reported as `blocked` so a run can be
   * interrupted cleanly without leaving workers behind.
   */
  signal?: AbortSignal;
}

/** One entry of a {@link RunSummary}: a spec's dispatch/review outcome. */
export interface RunEntry {
  spec: TaskSpec;
  result: WorkerResult;
  verdict?: ReviewVerdict;
  /** git checkpoint id captured before accepting the changes (when available). */
  checkpoint?: string;
  /** Number of dispatch attempts actually made (0 when the task was blocked). */
  attempts: number;
}

/** Closed-loop run outcome for a set of task specs (design doc §7). */
export interface RunSummary {
  /** True when every entry ended with a passing review verdict. */
  ok: boolean;
  entries: RunEntry[];
}

// ─── Prompt builders ─────────────────────────────────────────────────────────

/**
 * Build the worker (coder subagent) prompt for a task spec.
 *
 * Declares the file-ownership discipline (design doc §4.7) and the strict
 * output protocol (design doc §4.4): the response MUST end with a single
 * ```json fenced block shaped like `WorkerResult`.
 */
export function buildWorkerPrompt(spec: TaskSpec): string {
  const fileHints =
    spec.files_hint.length > 0 ? spec.files_hint.join(", ") : "(none declared)";
  return [
    `Task ${spec.id}: ${spec.title}`,
    "",
    "## Context",
    spec.context || "(no context provided)",
    "",
    "## Instruction",
    spec.instruction,
    "",
    "## Acceptance criteria",
    ...spec.acceptance.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## File ownership discipline",
    `Only modify files listed in files_hint: [${fileHints}].`,
    "If you must touch other files, do NOT modify them — declare each one in the `notes` field of your result so the orchestrator can arbitrate.",
    "",
    "## Output protocol",
    "Your final response MUST end with exactly one ```json fenced block containing a single JSON object of this shape (WorkerResult):",
    "```json",
    `{
  "id": "${spec.id}",
  "status": "done | blocked | failed",
  "message": "<one line: what happened>",
  "changed_files": ["<every file you modified, workspace-relative>"],
  "summary": "<1-3 sentences on what you did>",
  "test_result": "<optional: test/typecheck output summary>",
  "notes": "<optional: files you wanted to touch but did not, env vars, follow-ups>"
}`,
    "```",
    'Use status "blocked" and explain why in "notes" when the task cannot be completed as specified.',
  ].join("\n");
}

/**
 * Build the reviewer subagent prompt. Includes the spec + worker result and
 * the verdict output protocol; tagged with {@link REVIEW_VERDICT_MARKER} so
 * injected test chats can distinguish reviewer dispatches from worker ones.
 */
export function buildReviewerPrompt(spec: TaskSpec, result: WorkerResult): string {
  return [
    `${REVIEW_VERDICT_MARKER} — you are the independent reviewer for task ${spec.id}.`,
    "",
    "## Task spec",
    "```json",
    JSON.stringify(spec, null, 2),
    "```",
    "",
    "## Worker result",
    "```json",
    JSON.stringify(result, null, 2),
    "```",
    "",
    "## Instructions",
    "1. Check EVERY acceptance item in the spec against the actual workspace (use read-only tools).",
    '2. An item like "includes unit tests" only counts when a real test covering the new behavior exists and passes.',
    "3. Import safety: for every NEW module in changed_files/files_hint, verify the module imports without side effects — top-level code must not run main-entry logic and must not crash at import time. A main guard that assumes process.argv[1] is defined (e.g. `path.resolve(process.argv[1])` before the check) is a defect; it must be defensive.",
    "4. Your final response MUST end with exactly one ```json fenced block:",
    "```json",
    '{ "passed": true, "failed_items": ["<acceptance item that failed>"], "suggestions": "<concrete fixes>" }',
    "```",
    '5. Set "passed" to false whenever an acceptance item fails, a changed file is out of scope, or an import-safety defect is found.',
  ].join("\n");
}

// ─── Structured-result parsing ─────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Try `JSON.parse` and keep only plain objects (WorkerResult / verdict shape). */
function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Scan from a `{` for the matching `}`, honoring strings/escapes. */
function scanBalancedBraces(text: string, start: number): number | undefined {
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
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

/**
 * Extract the LAST ```json fenced block from free-form LLM text; when no
 * fenced block parses, fall back to the last balanced `{...}` object.
 * Later fenced blocks take precedence over earlier ones.
 */
function extractLastJsonObject(text: string): Record<string, unknown> | undefined {
  const fences: string[] = [];
  for (const match of text.matchAll(/```[a-zA-Z0-9]*\s*\n?([\s\S]*?)```/g)) {
    const candidate = match[1]?.trim();
    if (candidate !== undefined && candidate.length > 0) fences.push(candidate);
  }
  for (let i = fences.length - 1; i >= 0; i -= 1) {
    const parsed = tryParseObject(fences[i]!);
    if (parsed !== undefined) return parsed;
  }
  let last: Record<string, unknown> | undefined;
  let start = text.indexOf("{");
  while (start !== -1) {
    const end = scanBalancedBraces(text, start);
    if (end !== undefined) {
      const parsed = tryParseObject(text.slice(start, end + 1));
      if (parsed !== undefined) last = parsed;
    }
    start = text.indexOf("{", start + 1);
  }
  return last;
}

/** Parse a reviewer subagent's final text into a {@link ReviewVerdict}. */
function parseReviewVerdict(text: string): ReviewVerdict {
  const obj = extractLastJsonObject(text);
  if (obj === undefined) {
    return { passed: false, failed_items: ["unparseable review verdict"] };
  }
  const failedItems = Array.isArray(obj.failed_items)
    ? obj.failed_items.map((item) => String(item))
    : [];
  const suggestions =
    typeof obj.suggestions === "string" && obj.suggestions.length > 0
      ? obj.suggestions
      : undefined;
  return {
    passed: obj.passed === true,
    failed_items: failedItems,
    ...(suggestions !== undefined ? { suggestions } : {}),
  };
}

/** Normalize a workspace-relative path for scope comparison (POSIX-style). */
function normalizeWorkspacePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

// ─── DAG helpers (design doc §4.5) ──────────────────────────────────────────

/**
 * Split specs into dispatch batches in topological order. Tasks within one
 * batch have no mutual dependencies; batches must be dispatched sequentially.
 *
 * @throws `Error("task dependency cycle detected")` when no spec is ready
 *   anymore, and `Error("Unknown task dependency: ...")` when a `depends_on`
 *   references an unknown task id.
 */
export function topologicalBatches(specs: TaskSpec[]): TaskSpec[][] {
  const ids = new Set(specs.map((spec) => spec.id));
  for (const spec of specs) {
    for (const dep of spec.depends_on ?? []) {
      if (!ids.has(dep)) {
        throw new Error(`Unknown task dependency: ${spec.id} -> ${dep}`);
      }
    }
  }
  const done = new Set<string>();
  const remaining = new Set(ids);
  const batches: TaskSpec[][] = [];
  while (remaining.size > 0) {
    const ready = specs.filter(
      (spec) =>
        remaining.has(spec.id) &&
        (spec.depends_on ?? []).every((dep) => done.has(dep)),
    );
    if (ready.length === 0) {
      throw new Error("task dependency cycle detected");
    }
    batches.push(ready);
    for (const spec of ready) {
      remaining.delete(spec.id);
      done.add(spec.id);
    }
  }
  return batches;
}

/**
 * Plan dispatch waves (design doc §4.7): topological order (§4.5) plus
 * file-ownership serialization. Tasks within one wave have no mutual
 * dependencies AND no overlapping `files_hint`, so they are safe to run in
 * parallel; waves must run sequentially.
 */
export function enforceFileOwnership(specs: TaskSpec[]): TaskSpec[][] {
  const waves: TaskSpec[][] = [];
  for (const batch of topologicalBatches(specs)) {
    let wave: TaskSpec[] = [];
    let owned = new Set<string>();
    const flush = (): void => {
      if (wave.length > 0) waves.push(wave);
      wave = [];
      owned = new Set();
    };
    for (const spec of batch) {
      const files = spec.files_hint.map(normalizeWorkspacePath);
      if (files.some((file) => owned.has(file))) flush();
      for (const file of files) owned.add(file);
      wave.push(spec);
    }
    flush();
  }
  return waves;
}

// ─── Import-safety gate (design §6.2 hardening) ────────────────────────────

/** Extensions considered dynamically importable modules for the import-safety gate. */
export const IMPORTABLE_MODULE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
]);

/**
 * Built-in import-safety probe: spawn a child process
 * `npx tsx -e "import('<relativeFile>').catch(...)"` with `cwd` set to the
 * workspace root. The child's `process.argv[1]` is undefined, so a
 * non-defensive main-entry guard (e.g. `path.resolve(process.argv[1])`
 * before the check) crashes exactly in this context — the defect class this
 * gate targets. 60s timeout; a non-zero exit reports the stderr tail.
 */
export function tsxImportProbe(
  workspaceRoot: string,
  relativeFile: string,
): Promise<{ ok: boolean; detail?: string }> {
  const normalized = normalizeWorkspacePath(relativeFile);
  // ESM relative specifiers must start with "./" or "../" — prepend when
  // the path is a plain workspace-relative one.
  const specifier =
    normalized.startsWith("./") || normalized.startsWith("../")
      ? normalized
      : `./${normalized}`;
  const quoted = specifier.replace(/"/g, '\\"');
  const script = `import("${quoted}").catch((error) => { console.error(String(error)); process.exit(1); });`;
  return new Promise((resolve) => {
    const child = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["tsx", "-e", script],
      { cwd: workspaceRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        detail: `probe spawn failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, detail: stderr.trim().slice(-300) || `exit code ${code}` });
    });
  });
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

/**
 * M1 pipeline orchestrator (Route A): dispatches TaskSpecs to coder
 * subagents, parses the structured `WorkerResult` callback, and runs the
 * acceptance/review pipeline with a bounded iteration loop.
 *
 * See docs/multi-agent-orchestration-design.md §4, §6, §7.
 */
export class PipelineOrchestrator {
  private readonly options: PipelineOrchestratorOptions;
  private readonly subagentTool: Tool<SubagentArgs>;
  private readonly workspaceRoot: string;
  private readonly attemptCounters = new Map<string, number>();
  /** In-memory event log for the orchestrator's whole lifetime. */
  readonly events: PipelineLogEvent[] = [];
  /** Serialised JSONL write chain — keeps event order in the log file. */
  private logChain: Promise<void> = Promise.resolve();
  /** Per-run cancellation signal, set by {@link run} and consulted on every dispatch/review call. */
  private runSignal?: AbortSignal;

  constructor(options: PipelineOrchestratorOptions) {
    this.options = options;
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    // The subagent tool is created ONCE and shared by worker and reviewer
    // dispatches so a single injected faux chat can drive both offline.
    this.subagentTool = createSubagentTool({
      parentLlm: options.parentLlm,
      parentTools: options.parentTools,
      profiles: defaultProfiles,
      ...(options.chat !== undefined ? { chat: options.chat } : {}),
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.globalTokenBudget !== undefined
        ? { globalTokenBudget: options.globalTokenBudget }
        : {}),
      ...(options.roleLlmConfigs !== undefined ? { roleLlmConfigs: options.roleLlmConfigs } : {}),
      ...(options.onSubagentEvent !== undefined
        ? { onSubagentEvent: options.onSubagentEvent }
        : {}),
    });
  }

  /**
   * Parse a worker subagent's final text into a structured {@link WorkerResult}.
   * Prefers the last ```json fenced block, then the last balanced `{...}`
   * object. Missing fields are coerced (changed_files → [], status → "done"
   * when the object parsed and no status was given); unparseable text yields
   * a `failed` result with `error: "unparseable worker result"`.
   */
  static parseWorkerResult(text: string): WorkerResult {
    const obj = extractLastJsonObject(text);
    if (obj === undefined) {
      return {
        id: "",
        status: "failed",
        message: text.slice(-200),
        changed_files: [],
        summary: "",
        error: "unparseable worker result",
      };
    }
    const str = (value: unknown): string | undefined =>
      value === undefined || value === null
        ? undefined
        : typeof value === "string"
          ? value
          : String(value);
    // Missing status defaults to "done" (parsed-callback case); unrecognized
    // status values are coerced to "failed".
    let status: WorkerResult["status"];
    if (obj.status === "done" || obj.status === "blocked") status = obj.status;
    else if (obj.status === undefined) status = "done";
    else status = "failed";
    return {
      id: str(obj.id) ?? "",
      status,
      message: str(obj.message) ?? "",
      changed_files: Array.isArray(obj.changed_files)
        ? obj.changed_files.map((file) => String(file))
        : [],
      summary: str(obj.summary) ?? "",
      ...(str(obj.test_result) !== undefined ? { test_result: str(obj.test_result) } : {}),
      ...(str(obj.notes) !== undefined ? { notes: str(obj.notes) } : {}),
      ...(typeof obj.attempt === "number" ? { attempt: obj.attempt } : {}),
      ...(str(obj.nonce) !== undefined ? { nonce: str(obj.nonce) } : {}),
      ...(str(obj.error) !== undefined ? { error: str(obj.error) } : {}),
      ...(str(obj.branch) !== undefined ? { branch: str(obj.branch) } : {}),
    };
  }

  /** Topological batch helper — same semantics as the free {@link topologicalBatches}. */
  topologicalBatches(specs: TaskSpec[]): TaskSpec[][] {
    return topologicalBatches(specs);
  }

  /** Planned dispatch waves: topological order (§4.5) + file-ownership serialization (§4.7). */
  planBatches(specs: TaskSpec[]): TaskSpec[][] {
    return enforceFileOwnership(specs);
  }

  /** Within-wave parallelism (default 1 = M1 serial behavior). */
  private maxConcurrency(): number {
    return Math.max(1, this.options.maxConcurrency ?? 1);
  }

  /** Run `fn` over `items` with at most `limit` in flight; preserves input order. */
  private async mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(limit, items.length); i += 1) {
      workers.push(
        (async (): Promise<void> => {
          for (;;) {
            const index = next;
            next += 1;
            if (index >= items.length) return;
            results[index] = await fn(items[index]!);
          }
        })(),
      );
    }
    await Promise.all(workers);
    return results;
  }

  /**
   * Dispatch one task spec to a coder subagent and return its structured
   * callback. Emits `dispatch` (with the per-task attempt counter, default 1)
   * and, after the callback is parsed, `done`/`fail` plus `callback`.
   */
  async dispatch(spec: TaskSpec): Promise<WorkerResult> {
    const attempt = this.nextAttempt(spec);
    const model =
      spec.model_hint !== undefined
        ? this.options.modelMapping?.[spec.model_hint]
        : undefined;
    this.emit(spec.id, "dispatch", { model: model ?? "inherited" }, attempt);

    let result: WorkerResult;
    try {
      const toolResult = await this.subagentTool.execute(
        {
          task: buildWorkerPrompt(spec),
          sharedContext: spec.context,
          profile: "coder",
          ...(model !== undefined ? { model } : {}),
          maxTurns: this.options.workerMaxTurns ?? DEFAULT_WORKER_MAX_TURNS,
          ...(this.options.workerTokenBudget !== undefined
            ? { tokenBudget: this.options.workerTokenBudget }
            : {}),
        },
        this.runSignal ?? this.options.signal,
      );
      const text = contentAsString(toolResult.content);
      if (toolResult.isError) {
        result = {
          id: spec.id,
          status: "failed",
          message: "worker subagent reported an error",
          changed_files: [],
          summary: "",
          attempt,
          error: text.slice(0, 300),
        };
      } else {
        const parsed = PipelineOrchestrator.parseWorkerResult(text);
        // Guarantee the callback carries the spec's task id even when the
        // worker's JSON omitted it.
        result = {
          ...parsed,
          id: parsed.id || spec.id,
          attempt,
        };
      }
    } catch (error) {
      result = {
        id: spec.id,
        status: "failed",
        message: "worker dispatch threw",
        changed_files: [],
        summary: "",
        attempt,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (result.status === "done") {
      this.emit(spec.id, "done", {}, attempt);
    } else {
      this.emit(spec.id, "fail", { status: result.status }, attempt);
    }
    this.emit(spec.id, "callback", { status: result.status }, attempt);
    return result;
  }

  /**
   * Dispatch every spec through planned waves (topological order §4.5 with
   * file-ownership serialization §4.7). Within a wave, up to `maxConcurrency`
   * (default 1 — M1 serial behavior) tasks run in parallel. When a task's
   * result is not `done`, all transitive dependents are returned as
   * `status: "blocked"` WITHOUT being dispatched. Results are returned in
   * the original spec order.
   */
  async dispatchAll(specs: TaskSpec[]): Promise<WorkerResult[]> {
    const batches = this.planBatches(specs);
    const results = new Map<string, WorkerResult>();
    const notDone = new Set<string>();
    for (const batch of batches) {
      await this.mapWithConcurrency(batch, this.maxConcurrency(), async (spec) => {
        const blockedBy = (spec.depends_on ?? []).filter((dep) => notDone.has(dep));
        if (blockedBy.length > 0) {
          const blocked: WorkerResult = {
            id: spec.id,
            status: "blocked",
            message: `blocked by upstream task(s): ${blockedBy.join(", ")}`,
            changed_files: [],
            summary: "",
          };
          results.set(spec.id, blocked);
          notDone.add(spec.id);
          this.emit(spec.id, "fail", { status: "blocked", blocked_by: blockedBy }, 0);
          return;
        }
        const result = await this.dispatch(spec);
        results.set(spec.id, result);
        if (result.status !== "done") notDone.add(spec.id);
      });
    }
    return specs.map((spec) => {
      const existing = results.get(spec.id);
      if (existing !== undefined) return existing;
      // Defensive only: topologicalBatches covers every spec, so a result
      // always exists by the time we reach here.
      return {
        id: spec.id,
        status: "blocked" as const,
        message: "not dispatched",
        changed_files: [],
        summary: "",
      };
    });
  }

  /**
   * Closed-loop run (design doc §7): for each spec (planned waves §4.5/§4.7,
   * serial within a wave unless `maxConcurrency` > 1), dispatch → review.
   * When the review fails and the iteration budget remains, the task is
   * re-dispatched with the failed items/suggestions appended to the
   * instruction as "Previous attempt feedback" (the per-task attempt counter
   * increments on re-dispatch). After `maxIter` failures the task is recorded
   * as `failed`. Specs whose upstream task did not pass are returned as
   * `blocked` without dispatch.
   */
  async run(specs: TaskSpec[], options: RunOptions = {}): Promise<RunSummary> {
    const maxIter = Math.max(1, options.maxIter ?? DEFAULT_MAX_ITER);
    const batches = this.planBatches(specs);
    const completed = new Set<string>();
    const entries: RunEntry[] = [];
    const signal = options.signal ?? this.options.signal;
    if (signal !== undefined) {
      this.runSignal = signal;
    }

    for (const batch of batches) {
      // Respect cancellation between waves so no further work is scheduled.
      if (this.runSignal?.aborted) {
        const blocked: WorkerResult = {
          id: "__cancelled__",
          status: "blocked",
          message: "run aborted before dispatch",
          changed_files: [],
          summary: "",
        };
        for (const spec of batch) {
          if (!entries.some((entry) => entry.spec.id === spec.id)) {
            entries.push({ spec, result: blocked, attempts: 0 });
            this.emit(spec.id, "fail", { status: "blocked", blocked_by: ["run aborted"] }, 0);
          }
        }
        continue;
      }
      const wave = await this.mapWithConcurrency(
        batch,
        this.maxConcurrency(),
        async (spec): Promise<RunEntry> => {
          if (this.runSignal?.aborted) {
            const blocked: WorkerResult = {
              id: spec.id,
              status: "blocked",
              message: "run aborted before dispatch",
              changed_files: [],
              summary: "",
            };
            this.emit(spec.id, "fail", { status: "blocked", blocked_by: ["run aborted"] }, 0);
            return { spec, result: blocked, attempts: 0 };
          }
          const blockedBy = (spec.depends_on ?? []).filter(
            (dep) => !completed.has(dep),
          );
          if (blockedBy.length > 0) {
            const blocked: WorkerResult = {
              id: spec.id,
              status: "blocked",
              message: `blocked by upstream task(s): ${blockedBy.join(", ")}`,
              changed_files: [],
              summary: "",
            };
            this.emit(spec.id, "fail", { status: "blocked", blocked_by: blockedBy }, 0);
            return { spec, result: blocked, attempts: 0 };
          }
          return this.processTask(spec, maxIter, completed);
        },
      );
      entries.push(...wave);
    }

    this.runSignal = undefined;

    return {
      ok: entries.every(
        (entry) =>
          entry.result.status === "done" && (entry.verdict?.passed ?? true),
      ),
      entries,
    };
  }

  /** Per-task closed loop (design §7): dispatch → review → bounded revision re-dispatch. */
  private async processTask(
    spec: TaskSpec,
    maxIter: number,
    completed: Set<string>,
  ): Promise<RunEntry> {
    let current = spec;
    let result: WorkerResult = {
      id: spec.id,
      status: "blocked",
      message: "not dispatched",
      changed_files: [],
      summary: "",
    };
    let verdict: ReviewVerdict | undefined;
    let attempts = 0;
    let checkpoint: string | undefined;
    // Capture a rollback point BEFORE the first dispatch so a failed attempt's
    // workspace changes can be discarded without polluting the next task
    // (design §7.1).
    if (this.options.captureCheckpoint !== false) {
      const preCheckpoint = await this.captureCheckpoint(spec.id);
      if (preCheckpoint !== undefined) {
        checkpoint = preCheckpoint;
      }
    }
    for (let iter = 1; iter <= maxIter; iter += 1) {
      attempts = iter;
      result = await this.dispatch(current);
      verdict = await this.review(result, current);
      if (verdict.passed) {
        // Refresh the checkpoint so a later rollback targets the accepted state
        // rather than the pre-task state.
        const acceptedCheckpoint =
          this.options.captureCheckpoint === false
            ? undefined
            : await this.captureCheckpoint(spec.id);
        if (acceptedCheckpoint !== undefined) {
          checkpoint = acceptedCheckpoint;
        }
        this.emit(spec.id, "merge", checkpoint !== undefined ? { checkpoint } : {}, iter);
        break;
      }
      if (iter === maxIter) {
        // Iteration budget exhausted: mark the task failed (design §7).
        result = {
          ...result,
          status: "failed",
          error:
            result.error ??
            `review failed after ${maxIter} attempt(s): ${verdict.failed_items.join("; ")}`,
        };
        this.emit(spec.id, "fail", { attempts }, attempts);
        break;
      }
      // Revision spec: carry the feedback into the next dispatch. The
      // revision keeps the same spec id, so dispatch()'s per-task attempt
      // counter increments naturally.
      const feedback = JSON.stringify({
        failed_items: verdict.failed_items,
        suggestions: verdict.suggestions,
      });
      current = {
        ...current,
        instruction:
          current.instruction +
          "\n\n## Previous attempt feedback\n" +
          feedback,
      };
      this.emit(spec.id, "retry", { reason: verdict.failed_items.join("; ") }, iter);
    }

    if (result.status === "done" && (verdict?.passed ?? true)) {
      completed.add(spec.id);
    }
    return {
      spec,
      result,
      ...(verdict !== undefined ? { verdict } : {}),
      ...(checkpoint !== undefined ? { checkpoint } : {}),
      attempts,
    };
  }

  /**
   * Run the acceptance pipeline (design doc §6.1) for a worker result:
   * 1. status gate — `status` must be "done";
   * 2. file-scope gate — every changed file must exist on disk under
   *    `workspaceRoot` and be within `files_hint` ∪ files declared in `notes`;
   * 3. validate gate — optional hard validation (test/typecheck/build);
   * 4. import-safety gate — optional: every importable module in
   *    `changed_files` must survive a bare dynamic import
   *    (`importSafety` / `importSafetyProbe`);
   * 5. reviewer gate — an independent reviewer subagent returns a verdict
   *    (skippable via `skipReviewer`; the gates above still apply).
   * All gates passing ⇒ `verdict.passed === true` with merged failed_items.
   */
  async review(result: WorkerResult, spec: TaskSpec): Promise<ReviewVerdict> {
    // Gate 1: worker status.
    if (result.status !== "done") {
      const verdict: ReviewVerdict = {
        passed: false,
        failed_items: [`worker status: ${result.status}`],
      };
      this.emit(spec.id, "review_fail", { gate: "status" }, result.attempt);
      return verdict;
    }

    // Gate 2: file scope.
    const scopeIssues = this.fileScopeIssues(spec, result);
    if (scopeIssues.length > 0) {
      const verdict: ReviewVerdict = { passed: false, failed_items: scopeIssues };
      this.emit(
        spec.id,
        "review_fail",
        { gate: "file_scope", failed_items: scopeIssues },
        result.attempt,
      );
      return verdict;
    }

    // Gate 3: hard validation — the injected `validate` function when
    // provided, otherwise the auto-discovered `validate_workspace` tool
    // (skipped entirely when neither is available).
    const validation = await this.runValidation(spec.id);
    if (!validation.ok) {
      const verdict: ReviewVerdict = {
        passed: false,
        failed_items: ["workspace validation failed"],
        suggestions: validation.report,
      };
      this.emit(spec.id, "review_fail", { gate: "validate" }, result.attempt);
      return verdict;
    }

    // Gate 3.5: import safety — every importable module in changed_files
    // must survive a bare dynamic import (opt-in gate, §6.2 hardening).
    const importIssues = await this.importSafetyIssues(spec, result);
    if (importIssues.length > 0) {
      const verdict: ReviewVerdict = { passed: false, failed_items: importIssues };
      this.emit(
        spec.id,
        "review_fail",
        { gate: "import_safety", failed_items: importIssues },
        result.attempt,
      );
      return verdict;
    }

    // Gate 4: independent reviewer — externalReviewer takes precedence over
    // the built-in reviewer subagent; skipReviewer disables the gate entirely.
    let reviewerVerdict: ReviewVerdict;
    if (this.options.externalReviewer) {
      try {
        reviewerVerdict = await this.options.externalReviewer(result, spec);
        // Normalise: `passed: false` with empty failed_items is still a
        // failure; surface a generic item so the retry loop has actionable
        // feedback.
        if (!reviewerVerdict.passed && reviewerVerdict.failed_items.length === 0) {
          reviewerVerdict = { ...reviewerVerdict, failed_items: ["reviewer reported failure (no details)"] };
        }
      } catch (error) {
        reviewerVerdict = {
          passed: false,
          failed_items: [
            `external reviewer failed: ${error instanceof Error ? error.message : String(error)}`,
          ],
        };
      }
    } else {
      reviewerVerdict = this.options.skipReviewer
        ? { passed: true, failed_items: [] as string[] }
        : await this.dispatchReviewer(spec, result);
    }
    const verdict: ReviewVerdict = {
      passed: reviewerVerdict.passed && reviewerVerdict.failed_items.length === 0,
      failed_items: [...reviewerVerdict.failed_items],
      ...(reviewerVerdict.suggestions !== undefined
        ? { suggestions: reviewerVerdict.suggestions }
        : {}),
    };
    this.emit(
      spec.id,
      verdict.passed ? "review_pass" : "review_fail",
      { gate: "reviewer" },
      result.attempt,
    );
    return verdict;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** Increment (and return) the per-task-id dispatch attempt counter. */
  private nextAttempt(spec: TaskSpec): number {
    const next = (this.attemptCounters.get(spec.id) ?? 0) + 1;
    this.attemptCounters.set(spec.id, next);
    return next;
  }

  private emit(
    taskId: string,
    event: PipelineEventName,
    extra: Record<string, unknown> = {},
    attempt?: number,
  ): void {
    const logEvent: PipelineLogEvent = {
      ts: new Date().toISOString(),
      task_id: taskId,
      event,
      ...(attempt !== undefined ? { attempt } : {}),
      ...extra,
    };
    this.events.push(logEvent);
    this.options.onEvent?.(logEvent);
    if (this.options.logDir !== undefined) {
      // Best-effort, order-preserving, and never blocks or breaks the pipeline.
      this.logChain = this.logChain.then(() => this.appendFileLog(logEvent));
    }
  }

  /** Await all pending JSONL file-log writes (used by tests and shutdown). */
  async flushLogs(): Promise<void> {
    await this.logChain;
  }

  private async appendFileLog(logEvent: PipelineLogEvent): Promise<void> {
    const dir = this.options.logDir!;
    const safeId = logEvent.task_id.replace(/[^\w.-]/g, "_");
    try {
      await mkdir(dir, { recursive: true });
      await appendFile(join(dir, `${safeId}.jsonl`), `${JSON.stringify(logEvent)}\n`, "utf8");
    } catch {
      // Ignore logging failures — the pipeline must never break on I/O.
    }
  }

  /** Find a tool by name in the parent tool provider. */
  private findParentTool(name: string): Tool | undefined {
    return resolveToolProvider(this.options.parentTools).find((t) => t.name === name);
  }

  /**
   * Gate 3 resolver: uses the injected `validate` function when provided,
   * otherwise auto-discovers a `validate_workspace` tool in the parent tool
   * set and runs it with `validationSteps`. When neither is available the
   * gate is skipped (`ok: true, skipped: true`) so the pipeline never
   * hard-fails on missing validation infrastructure.
   */
  private async runValidation(
    taskId: string,
  ): Promise<{ ok: boolean; report: string; skipped: boolean }> {
    if (this.options.validate !== undefined) {
      this.emit(taskId, "tool_call", { tool: "validate" });
      const report = await this.options.validate();
      return { ok: report.ok, report: report.report, skipped: false };
    }
    const tool = this.findParentTool("validate_workspace");
    if (tool === undefined) {
      return {
        ok: true,
        report: "validate_workspace tool unavailable — validation skipped",
        skipped: true,
      };
    }
    this.emit(taskId, "tool_call", { tool: "validate_workspace" });
    try {
      const toolResult = await tool.execute(
        { steps: this.options.validationSteps ?? DEFAULT_VALIDATION_STEPS },
        this.runSignal ?? this.options.signal,
      );
      const report = contentAsString(toolResult.content);
      return { ok: !toolResult.isError, report, skipped: false };
    } catch (error) {
      return {
        ok: false,
        report: `validation tool error: ${error instanceof Error ? error.message : String(error)}`,
        skipped: false,
      };
    }
  }

  /**
   * Import-safety gate check (§6.2 hardening): every importable module in
   * `changed_files` (by extension, {@link IMPORTABLE_MODULE_EXTENSIONS})
   * must survive a bare dynamic import — catching non-defensive main-entry
   * guards that crash in import/eval contexts. Opt-in: a custom
   * `importSafetyProbe` takes precedence; `importSafety: true` enables the
   * built-in child-process probe ({@link tsxImportProbe}). Disabled when
   * neither option is set.
   */
  private async importSafetyIssues(spec: TaskSpec, result: WorkerResult): Promise<string[]> {
    const probe = this.options.importSafetyProbe;
    if (probe === undefined && this.options.importSafety !== true) return [];
    const issues: string[] = [];
    for (const file of result.changed_files) {
      const rel = normalizeWorkspacePath(file);
      const ext = extname(rel).replace(/^\./, "").toLowerCase();
      if (!IMPORTABLE_MODULE_EXTENSIONS.has(ext)) continue;
      if (!existsSync(join(this.workspaceRoot, rel))) continue; // missing files are reported by gate 2
      const outcome =
        probe !== undefined ? await probe(file) : await tsxImportProbe(this.workspaceRoot, rel);
      if (!outcome.ok) {
        issues.push(
          `import safety: ${file} fails bare dynamic import${outcome.detail ? ` (${outcome.detail})` : ""}`,
        );
      }
    }
    return issues;
  }

  /**
   * Capture a rollback point before accepting a passing task (design §7.1):
   * invokes the parent tool set's `git_checkpoint` when available and
   * returns the checkpoint id (or the first line of its output). Undefined
   * when the tool is missing or fails — never blocks the pipeline.
   */
  private async captureCheckpoint(taskId: string): Promise<string | undefined> {
    const tool = this.findParentTool("git_checkpoint");
    if (tool === undefined) return undefined;
    this.emit(taskId, "tool_call", { tool: "git_checkpoint" });
    try {
      const toolResult = await tool.execute(
        { label: `pre-${taskId}` },
        this.runSignal ?? this.options.signal,
      );
      const text = contentAsString(toolResult.content).trim();
      if (!text) return undefined;
      const obj = extractLastJsonObject(text);
      const id = obj?.checkpointId ?? obj?.id;
      return typeof id === "string" ? id : text.split("\n")[0].slice(0, 200);
    } catch {
      return undefined;
    }
  }

  private async dispatchReviewer(
    spec: TaskSpec,
    result: WorkerResult,
  ): Promise<ReviewVerdict> {
    try {
      const toolResult = await this.subagentTool.execute(
        {
          task: buildReviewerPrompt(spec, result),
          sharedContext: spec.context,
          profile: "reviewer",
          ...(this.options.reviewerTokenBudget !== undefined
            ? { tokenBudget: this.options.reviewerTokenBudget }
            : {}),
        },
        this.runSignal ?? this.options.signal,
      );
      return parseReviewVerdict(contentAsString(toolResult.content));
    } catch (error) {
      return {
        passed: false,
        failed_items: [
          `reviewer subagent failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  /**
   * Gate 2 check (design doc §6.1 step 2): every changed file must exist on
   * disk under `workspaceRoot` AND be within `files_hint` ∪ files declared
   * in `notes`. Notes-declared files are extracted as a simple heuristic:
   * backtick-quoted tokens plus any token containing a dot (`/\S+\.\S+/`),
   * which covers `./src/foo.ts`-style path mentions.
   */
  private fileScopeIssues(spec: TaskSpec, result: WorkerResult): string[] {
    if (result.changed_files.length === 0) return [];
    const allowed = this.allowedFiles(spec, result);
    const issues: string[] = [];
    for (const file of result.changed_files) {
      const normalized = normalizeWorkspacePath(file);
      if (!existsSync(join(this.workspaceRoot, normalized))) {
        issues.push(`changed file does not exist: ${file}`);
        continue;
      }
      if (!allowed.has(normalized) && !allowed.has(file)) {
        issues.push(`out-of-scope changed file: ${file}`);
      }
    }
    return issues;
  }

  private allowedFiles(spec: TaskSpec, result: WorkerResult): Set<string> {
    const allowed = new Set(spec.files_hint.map(normalizeWorkspacePath));
    const notes = result.notes ?? "";
    for (const match of notes.matchAll(/`([^`]+)`/g)) {
      allowed.add(normalizeWorkspacePath(match[1]));
    }
    for (const match of notes.matchAll(/\S+\.\S+/g)) {
      allowed.add(normalizeWorkspacePath(match[0]));
    }
    return allowed;
  }
}

// ─── LLM-invokable tool wrapper (design doc §2: dispatch(spec)) ────────────

/** Arguments for the {@link createPipelineTool} wrapper. */
export type PipelineToolArgs = {
  spec: TaskSpec;
  /** Override the orchestrator's max iteration count for this run. */
  maxIteration?: number;
};

/**
 * Expose the pipeline as a single tool so the orchestrating agent can run
 * "dispatch → validate → review → iterate" in one call. Executes one spec
 * through {@link PipelineOrchestrator.run} and returns a structured
 * `merged` / `escalated` outcome as JSON.
 *
 * When the parent tool set contains `validate_workspace` / `git_checkpoint`
 * tools they are auto-discovered and used by the run (design §6.1 / §7.1).
 */
export function createPipelineTool(options: PipelineOrchestratorOptions): Tool<PipelineToolArgs> {
  const orchestrator = new PipelineOrchestrator(options);
  return {
    name: "development_pipeline",
    description:
      "Run the full development pipeline for one task spec: dispatch a coder subagent, " +
      "run workspace validation, review with an independent reviewer subagent, and iterate " +
      "until the gates pass or maxIteration is exhausted. Returns a structured outcome.",
    parameters: {
      type: "object",
      properties: {
        spec: {
          type: "object",
          description: "The task spec to develop and review.",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            context: { type: "string" },
            instruction: { type: "string" },
            acceptance: { type: "array", items: { type: "string" } },
            files_hint: { type: "array", items: { type: "string" } },
            depends_on: { type: "array", items: { type: "string" } },
            model_hint: { type: "string", enum: ["light", "standard", "flagship"] },
          },
          required: ["id", "instruction", "acceptance"],
        },
        maxIteration: {
          type: "integer",
          minimum: 1,
          maximum: 5,
          description: "Max auto-iterations when the review gate fails.",
        },
      },
      required: ["spec"],
    },
    execute: async (args) => {
      const { spec, maxIteration } = args;
      if (
        !spec ||
        typeof spec.id !== "string" ||
        typeof spec.instruction !== "string" ||
        !Array.isArray(spec.acceptance)
      ) {
        return {
          content:
            "development_pipeline: invalid spec — requires spec.id, spec.instruction and spec.acceptance[]",
          isError: true,
        };
      }
      const normalized: TaskSpec = {
        id: spec.id,
        title: typeof spec.title === "string" ? spec.title : spec.id,
        context: typeof spec.context === "string" ? spec.context : "",
        instruction: spec.instruction,
        acceptance: spec.acceptance.map(String),
        files_hint: Array.isArray(spec.files_hint) ? spec.files_hint.map(String) : [],
        ...(Array.isArray(spec.depends_on) ? { depends_on: spec.depends_on.map(String) } : {}),
        ...(spec.model_hint === "light" || spec.model_hint === "standard" || spec.model_hint === "flagship"
          ? { model_hint: spec.model_hint }
          : {}),
      };
      const summary = await orchestrator.run([normalized], { maxIter: maxIteration });
      const entry = summary.entries[0];
      const passed =
        entry.result.status === "done" && (entry.verdict?.passed ?? entry.result.status === "done");
      const outcome = passed
        ? {
            status: "merged" as const,
            spec: entry.spec,
            result: entry.result,
            review: entry.verdict,
            iterations: entry.attempts,
            ...(entry.checkpoint !== undefined ? { checkpoint: entry.checkpoint } : {}),
          }
        : {
            status: "escalated" as const,
            spec: entry.spec,
            result: entry.result,
            review: entry.verdict,
            iterations: entry.attempts,
            reason:
              entry.verdict?.failed_items.join("; ") ||
              entry.result.error ||
              entry.result.message ||
              "unknown",
          };
      return {
        content: JSON.stringify(outcome, null, 2),
        isError: !passed,
      };
    },
  };
}
