/**
 * Search-then-orchestrate workflow.
 *
 * Mirrors the shape of "search the web, then fan the findings out to
 * specialised subagents": a read-only planner turns the question plus the
 * search evidence into a task DAG, the DAG is dispatched to the existing
 * subagent runtime (each task may pin its own model), and a synthesis step
 * merges the results into one answer with its sources.
 *
 * Everything here is built on primitives that already exist:
 *
 *   - `web_search` / `fetch_content` supply the evidence (as tools the planner
 *     and workers can call themselves, so no search API is hard-coded here).
 *   - `createSubagentTool` supplies execution; model overrides travel through
 *     `SubagentArgs.model`, which already supports third-party gateway models.
 *
 * The search backend is therefore whatever the host wired into the tool set,
 * including MCP-provided search tools.
 */

import { contentAsString } from "../content.ts";
import type { Tool, ToolProvider } from "../tools/types.ts";
import { createSubagentTool, defaultProfiles } from "../subagent/index.ts";
import type { SubagentArgs, SubagentProfile } from "../subagent/types.ts";
import type { ChatFn, LlmConfig } from "../llm/index.ts";
import type { ModelHint } from "./pipeline/types.ts";
import { topologicalBatches } from "./pipeline/orchestrator.ts";

// ─── Public types ────────────────────────────────────────────────────────────

/** One unit of work handed to a subagent. */
export interface SearchTask {
  /** Unique id, referenced by `dependsOn` of later tasks. */
  id: string;
  /** Subagent profile to run (must exist in `profiles`). */
  profile: string;
  /** Instruction for the subagent. */
  instruction: string;
  /** Task ids that must finish before this one starts. */
  dependsOn?: string[];
  /**
   * Model id for this task. Any catalog id or persisted custom-provider model
   * (`provider/model`) works; omit to inherit the parent model.
   */
  model?: string;
  /** Complexity hint, resolved through `modelMapping` when `model` is absent. */
  modelHint?: ModelHint;
}

/** Terminal state of one dispatched task. */
export interface SearchTaskResult {
  id: string;
  status: "done" | "failed";
  /** Subagent output (or the error message on failure). */
  output: string;
  /** Model actually requested for this task. */
  model?: string;
  /** Error text when `status` is "failed". */
  error?: string;
}

/** Options for {@link runSearchOrchestration}. */
export interface SearchOrchestrationOptions {
  /** The user's question. */
  query: string;
  /**
   * An already-configured `subagent` tool to route every call through.
   *
   * Supply this when the host owns the subagent wiring (TUI, server, CLI): the
   * workflow then inherits the same profiles, permission turn, token budgets,
   * preprocessors and role model bindings as any other subagent call.
   *
   * When omitted, a tool is built from `parentLlm` + `parentTools` with none of
   * those extras — only suitable for standalone use and tests.
   */
  subagent?: Tool<SubagentArgs>;
  /** LLM config the subagents inherit when no `subagent` tool is supplied. */
  parentLlm?: LlmConfig;
  /** Parent tool set; subagents pick their profile's subset from it. */
  parentTools?: ToolProvider;
  /** Profiles available when building an internal tool. Defaults to the built-in set. */
  profiles?: SubagentProfile[];
  /**
   * Models this orchestrator may use. Each task is resolved against this list
   * by id, qualified `provider/model`, or fuzzy name.
   */
  models?: Array<{ id: string; provider: string; name?: string }>;
  /** Map a `modelHint` to a concrete model id. */
  modelMapping?: Partial<Record<ModelHint, string>>;
  /**
   * Cap on tasks the planner may emit. Default 6 — enough for a branched
   * investigation without fanning out into an unbounded run.
   */
  maxTasks?: number;
  /**
   * Max planning attempts when the plan fails validation. Default 2.
   */
  maxPlanRounds?: number;
  /** Within-wave parallelism. Default 3. */
  maxConcurrency?: number;
  /** Max turns per subagent task. Default 20. */
  maxTurns?: number;
  /** Per-task token budget. Omit for unlimited. */
  tokenBudget?: number;
  /** Hard timeout (ms) per task. Omit for no timeout. */
  timeout?: number;
  /** Cancellation signal propagated to every subagent. */
  signal?: AbortSignal;
  /** Inject a faux chat function for offline tests. */
  chat?: ChatFn;
  /** Structured progress callback. */
  onEvent?: (event: SearchOrchestrationEvent) => void;
  /** Emit the plan without dispatching (useful for previews/tests). */
  planOnly?: boolean;
}

/** Progress events emitted by the workflow. */
export type SearchOrchestrationEvent =
  | { type: "plan"; tasks: SearchTask[]; round: number }
  | {
      type: "dispatch";
      id: string;
      profile: string;
      model?: string;
      /**
       * Set when the planner named a model that no catalog entry matched; the
       * task ran on the inherited model instead of guessing an endpoint.
       */
      modelUnresolved?: string;
    }
  | { type: "done"; id: string; status: "done" | "failed" }
  | { type: "synthesize"; taskCount: number };

/** Outcome of a full run. */
export interface SearchOrchestrationResult {
  query: string;
  tasks: SearchTask[];
  results: SearchTaskResult[];
  /** Merged answer. Empty when `planOnly` was set or planning failed. */
  answer: string;
  /** Number of planning rounds used (1 = accepted on the first try). */
  planRounds: number;
}

// ─── Planning ────────────────────────────────────────────────────────────────

/**
 * Build the planner prompt. The planner is told to search before planning so
 * the task graph reflects real evidence instead of guessed subtopics.
 */
export function buildSearchPlanPrompt(
  query: string,
  maxTasks: number,
  availableProfiles: string[],
  feedback?: string,
): string {
  const lines = [
    "You are a research orchestrator. Break the user's question into focused subagent tasks.",
    "",
    "## Question",
    query,
    "",
    "## Process",
    "1. Use `web_search` first to learn what the question actually involves.",
    "2. Read the most relevant sources (`fetch_content`) before deciding on the task breakdown.",
    "3. Split the question into tasks that each need a different angle — for",
    "   example gathering facts, comparing options, checking claims against",
    "   primary sources, or producing something concrete.",
    "",
    "## Task rules",
    `1. Emit at most ${maxTasks} tasks.`,
    `2. Each task's "profile" MUST be one of: ${availableProfiles.join(", ")}.`,
    "3. Use dependsOn (task ids) only when a task genuinely needs an earlier task's output.",
    "4. Never create a dependency cycle.",
    "5. Keep instructions self-contained: the subagent does not see the other tasks.",
    "6. Do not duplicate the same angle across tasks.",
    `7. model: optional. Include it only when a task clearly needs a specific model from the provided catalog.`,
    `8. modelHint: one of "light", "standard", "flagship" when no explicit model is needed.`,
    "",
    "## Output",
    "Reply with ONLY a JSON array. Each element:",
    '{"id": "t1", "profile": "researcher", "instruction": "...", "dependsOn": [], "modelHint": "standard"}',
  ];
  if (feedback) {
    lines.push("", "## Previous round was rejected — fix ALL of these, then re-emit the full array", feedback);
  }
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract the last JSON array from planner output (fenced block preferred). */
function extractJsonArray(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1] ?? "");
  for (const candidate of fenced.reverse()) {
    try {
      return JSON.parse(candidate.trim());
    } catch {
      // fall through to the balanced scan
    }
  }
  const start = text.indexOf("[");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * Parse and validate a planner response.
 *
 * Returns the accepted tasks, or a list of problems suitable for feeding back
 * into the next planning round. Validation is what keeps a hallucinated profile
 * or a dependency cycle from reaching the dispatcher.
 */
export function parseSearchPlan(
  text: string,
  maxTasks: number,
  knownProfiles: Set<string>,
): { tasks: SearchTask[] } | { issues: string[] } {
  const parsed = extractJsonArray(text);
  if (!Array.isArray(parsed)) return { issues: ["output was not a JSON array"] };
  if (parsed.length === 0) return { issues: ["task array was empty"] };

  const issues: string[] = [];
  if (parsed.length > maxTasks) {
    issues.push(`expected at most ${maxTasks} tasks, got ${parsed.length}`);
  }

  const tasks: SearchTask[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of parsed.slice(0, maxTasks).entries()) {
    if (!isRecord(raw)) {
      issues.push(`task ${index + 1} is not an object`);
      continue;
    }
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const profile = typeof raw.profile === "string" ? raw.profile.trim() : "";
    const instruction = typeof raw.instruction === "string" ? raw.instruction.trim() : "";
    if (!id) issues.push(`task ${index + 1} has no id`);
    else if (seen.has(id)) issues.push(`duplicate task id "${id}"`);
    if (!instruction) issues.push(`task ${index + 1} ("${id || "?"}") has no instruction`);
    if (!profile) issues.push(`task ${index + 1} ("${id || "?"}") has no profile`);
    else if (!knownProfiles.has(profile)) {
      issues.push(`task "${id || index + 1}" uses unknown profile "${profile}" (available: ${[...knownProfiles].join(", ")})`);
    }
    if (!id || !instruction || !profile) continue;
    seen.add(id);

    const dependsOn = Array.isArray(raw.dependsOn ?? raw.depends_on)
      ? (raw.dependsOn ?? raw.depends_on) as unknown[]
      : undefined;
    const deps = dependsOn
      ?.filter((dep): dep is string => typeof dep === "string" && dep.trim().length > 0)
      .map((dep) => dep.trim());

    const modelHint = raw.modelHint ?? raw.model_hint;
    tasks.push({
      id,
      profile,
      instruction,
      ...(deps && deps.length > 0 ? { dependsOn: deps } : {}),
      ...(typeof raw.model === "string" && raw.model.trim() ? { model: raw.model.trim() } : {}),
      ...(modelHint === "light" || modelHint === "standard" || modelHint === "flagship"
        ? { modelHint }
        : {}),
    });
  }

  // Dependency integrity: unknown targets and cycles would otherwise deadlock
  // or throw deep inside the dispatcher.
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (!ids.has(dep)) issues.push(`task "${task.id}" depends on unknown task "${dep}"`);
      if (dep === task.id) issues.push(`task "${task.id}" depends on itself`);
    }
  }
  if (issues.length === 0) {
    try {
      topologicalBatches(
        tasks.map((task) => ({
          id: task.id,
          title: task.id,
          context: "",
          instruction: task.instruction,
          acceptance: [],
          files_hint: [],
          ...(task.dependsOn ? { depends_on: task.dependsOn } : {}),
        })),
      );
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }

  return issues.length > 0 ? { issues } : { tasks };
}

// ─── Model resolution ────────────────────────────────────────────────────────

/**
 * Resolve a task's model reference against the supplied catalog.
 *
 * Accepts an exact `provider/model`, a bare id, or a fuzzy name, so both
 * catalog models and persisted custom-provider models resolve. Returns
 * undefined when nothing matches, letting the subagent inherit the parent model
 * rather than failing the task.
 */
export function resolveTaskModel(
  reference: string | undefined,
  models: Array<{ id: string; provider: string; name?: string }>,
): string | undefined {
  if (!reference) return undefined;
  const needle = reference.trim().toLowerCase();
  if (!needle) return undefined;
  const qualified = models.find((model) => `${model.provider}/${model.id}`.toLowerCase() === needle);
  if (qualified) return `${qualified.provider}/${qualified.id}`;
  const byId = models.find((model) => model.id.toLowerCase() === needle);
  if (byId) return `${byId.provider}/${byId.id}`;
  const byName = models.find((model) => (model.name ?? "").toLowerCase() === needle);
  if (byName) return `${byName.provider}/${byName.id}`;
  return undefined;
}

/**
 * Decide which model a task runs on.
 *
 * An explicit `task.model` is only honored when it resolves against the
 * supplied catalog. Passing an unresolved reference through would make
 * `switchLlmModel` fall back to the default OpenAI endpoint with an unrelated
 * key, so an unknown name inherits the parent model instead.
 */
export function resolveRequestedModel(
  task: Pick<SearchTask, "model" | "modelHint">,
  models: Array<{ id: string; provider: string; name?: string }>,
  modelMapping?: Partial<Record<ModelHint, string>>,
): string | undefined {
  if (task.model) return resolveTaskModel(task.model, models);
  if (task.modelHint) return modelMapping?.[task.modelHint];
  return undefined;
}

// ─── Workflow ────────────────────────────────────────────────────────────────

/**
 * Fail fast when a caller neither injects a `subagent` tool nor supplies the
 * pieces needed to build one.
 */
function requireParentLlm(options: SearchOrchestrationOptions): LlmConfig {
  if (!options.parentLlm) {
    throw new Error(
      "runSearchOrchestration requires either a `subagent` tool or a `parentLlm` config.",
    );
  }
  return options.parentLlm;
}

/** The profile used for the read-only planning and synthesis steps. */
const PLANNER_PROFILE = "web-researcher";

/**
 * Run the search-then-orchestrate workflow.
 *
 * Planning, dispatch and synthesis all go through `createSubagentTool`, so
 * permission checks, token budgets and third-party model overrides behave
 * exactly as they do for any other subagent call.
 */
export async function runSearchOrchestration(
  options: SearchOrchestrationOptions,
): Promise<SearchOrchestrationResult> {
  const profiles = options.profiles ?? defaultProfiles;
  const knownProfiles = new Set(profiles.map((profile) => profile.name));
  // Callers may supply their own profile list; fall back to whatever
  // read-only researcher they do have.
  const plannerProfile = knownProfiles.has(PLANNER_PROFILE)
    ? PLANNER_PROFILE
    : knownProfiles.has("researcher") ? "researcher" : [...knownProfiles][0] ?? "researcher";
  const maxTasks = options.maxTasks ?? 6;
  const maxPlanRounds = options.maxPlanRounds ?? 2;

  const tool = options.subagent ?? createSubagentTool({
    parentLlm: requireParentLlm(options),
    parentTools: options.parentTools ?? [],
    profiles,
    ...(options.chat ? { chat: options.chat } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
  });

  const invoke = async (args: SubagentArgs): Promise<string> => {
    const result = await tool.execute(args, options.signal);
    const text = contentAsString(result.content);
    if (result.isError) throw new Error(text);
    return text;
  };

  // ── Plan (with self-check feedback) ───────────────────────────────────────
  let tasks: SearchTask[] = [];
  let planRounds = 0;
  let feedback: string | undefined;
  for (let round = 1; round <= maxPlanRounds; round += 1) {
    planRounds = round;
    const text = await invoke({
      profile: plannerProfile,
      task: buildSearchPlanPrompt(options.query, maxTasks, [...knownProfiles], feedback),
      sharedContext: JSON.stringify({ query: options.query }),
    });
    const outcome = parseSearchPlan(text, maxTasks, knownProfiles);
    if ("tasks" in outcome) {
      tasks = outcome.tasks;
      options.onEvent?.({ type: "plan", tasks, round });
      break;
    }
    feedback = outcome.issues.map((issue) => `- ${issue}`).join("\n");
  }

  if (tasks.length === 0) {
    return { query: options.query, tasks: [], results: [], answer: "", planRounds };
  }
  if (options.planOnly) {
    return { query: options.query, tasks, results: [], answer: "", planRounds };
  }

  // ── Dispatch in dependency order ──────────────────────────────────────────
  const models = options.models ?? [];
  const resultsById = new Map<string, SearchTaskResult>();

  const runTask = async (task: SearchTask): Promise<SearchTaskResult> => {
    const requested = resolveRequestedModel(task, models, options.modelMapping);

    options.onEvent?.({
      type: "dispatch",
      id: task.id,
      profile: task.profile,
      ...(requested ? { model: requested } : {}),
      ...(requested ? {} : task.model ? { modelUnresolved: task.model } : {}),
    });

    // Only real dependencies' outputs are passed through, so a task never
    // inherits context from an unrelated sibling.
    const dependencies = (task.dependsOn ?? []).flatMap((dep) => {
      const prior = resultsById.get(dep);
      return prior && prior.status === "done" ? [{ id: dep, output: prior.output }] : [];
    });

    try {
      const output = await invoke({
        profile: task.profile,
        task: task.instruction,
        sharedContext: JSON.stringify({
          query: options.query,
          ...(dependencies.length > 0 ? { dependencies } : {}),
        }),
        ...(requested !== undefined ? { model: requested } : {}),
        ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
        ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
      });
      const result: SearchTaskResult = {
        id: task.id,
        status: "done",
        output,
        ...(requested !== undefined ? { model: requested } : {}),
      };
      options.onEvent?.({ type: "done", id: task.id, status: "done" });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onEvent?.({ type: "done", id: task.id, status: "failed" });
      return {
        id: task.id,
        status: "failed",
        output: "",
        ...(requested !== undefined ? { model: requested } : {}),
        error: message,
      };
    }
  };

  const batches = topologicalBatches(
    tasks.map((task) => ({
      id: task.id,
      title: task.id,
      context: "",
      instruction: task.instruction,
      acceptance: [],
      files_hint: [],
      ...(task.dependsOn ? { depends_on: task.dependsOn } : {}),
    })),
  );
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const concurrency = Math.max(1, options.maxConcurrency ?? 3);

  for (const batch of batches) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, batch.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= batch.length) return;
        const task = byId.get(batch[index]!.id);
        if (!task) continue;
        resultsById.set(task.id, await runTask(task));
      }
    });
    await Promise.all(workers);
  }

  const results = tasks.map((task) => resultsById.get(task.id) ?? {
    id: task.id,
    status: "failed" as const,
    output: "",
    error: "task was not executed",
  });

  // ── Synthesize ────────────────────────────────────────────────────────────
  options.onEvent?.({ type: "synthesize", taskCount: results.length });
  const completed = results.filter((result) => result.status === "done");
  if (completed.length === 0) {
    return { query: options.query, tasks, results, answer: "", planRounds };
  }

  const answer = await invoke({
    profile: plannerProfile,
    task: [
      "Answer the question by merging the subagent findings below.",
      "",
      "Rules:",
      "- Synthesize; do not just concatenate the sections.",
      "- Preserve every source URL the subagents cited.",
      "- Call out disagreements between sources instead of picking one silently.",
      "- State plainly what remained unresolved.",
      "",
      `Question: ${options.query}`,
    ].join("\n"),
    sharedContext: JSON.stringify({
      query: options.query,
      findings: completed.map((result) => ({ id: result.id, output: result.output })),
      ...(results.length > completed.length
        ? { failed: results.filter((r) => r.status === "failed").map((r) => r.id) }
        : {}),
    }),
  });

  return { query: options.query, tasks, results, answer, planRounds };
}

/** Convenience wrapper: expose the workflow as a single tool. */
export function createSearchOrchestrationTool(
  options: Omit<SearchOrchestrationOptions, "query" | "onEvent" | "planOnly"> & {
    onEvent?: SearchOrchestrationOptions["onEvent"];
  },
): Tool {
  return {
    name: "search_orchestrate",
    displayName: "Search & Orchestrate",
    description:
      "Search the web, split the question into subagent tasks (each may use its own model), then synthesize a sourced answer.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The question to research." },
        maxTasks: { type: "integer", minimum: 1, maximum: 12, description: "Cap on generated tasks." },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async execute(rawArgs, signal) {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        return { content: "query is required", isError: true };
      }
      const maxTasks = typeof args.maxTasks === "number" && Number.isInteger(args.maxTasks)
        ? Math.min(Math.max(args.maxTasks, 1), 12)
        : undefined;
      try {
        const result = await runSearchOrchestration({
          ...options,
          query,
          ...(maxTasks !== undefined ? { maxTasks } : {}),
          ...(signal ?? options.signal ? { signal: signal ?? options.signal } : {}),
        });
        const sources = result.results
          .filter((entry) => entry.status === "done")
          .map((entry) => `- ${entry.id}${entry.model ? ` (${entry.model})` : ""}`);
        const header = `Tasks: ${result.tasks.length} (${result.results.filter((r) => r.status === "done").length} ok)`;
        return {
          content: [
            result.answer || "No answer was produced.",
            "",
            "---",
            header,
            ...(sources.length > 0 ? ["Completed:", ...sources] : []),
          ].join("\n"),
        };
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
  };
}