// H3 多步规划引擎入口（design doc §4.1 / §4.5 / §4.8）：
// 把 `analyzeRequirement`（需求 → TaskSpec[] 拆解）+ `PipelineOrchestrator.run`
// （拓扑批次派发 + 闭环验收）串成一条端到端流水线。

import { analyzeRequirement, type SplitOptions } from "./splitter.ts";
import {
  createPipelineTool,
  PipelineOrchestrator,
  topologicalBatches,
  type RunOptions,
  type RunSummary,
  type PipelineOrchestratorOptions,
} from "./orchestrator.ts";
import type { TaskSpec } from "./types.ts";
import type { Tool } from "../../tools/types.ts";

export interface AnalyzeAndRunResult {
  /** 拆解出的全部任务 spec。 */
  specs: TaskSpec[];
  /** 拓扑批次（用于观察派发顺序，实际派发由 orchestrator 内部执行）。 */
  batches: TaskSpec[][];
  /** 端到端运行汇总。 */
  summary: RunSummary;
}

export interface AnalyzeAndRunOptions extends PipelineOrchestratorOptions {
  /** Optional extra options for the `analyzeRequirement` splitter. When
   *  omitted, `parentLlm` / `parentTools` / `chat` are inherited from the
   *  outer options so callers only need to supply `requirement` plus any
   *  splitter-specific knobs (e.g. `projectContext`, `maxTasks`). */
  split?: SplitOptions;
  /** `PipelineOrchestrator.run` options (default `maxIter` 3). */
  run?: RunOptions;
}

/**
 * H3 + H4 端到端：需求 → TaskSpec[] → 拓扑批次 → 派发/验收闭环。
 *
 * 1. 调 `analyzeRequirement`（researcher 子代理 + 自检重试）得到 spec 数组；
 * 2. 用 `topologicalBatches` 验证依赖无环（§4.5）；
 * 3. 交给 `PipelineOrchestrator` 执行派发 + 五道门禁验收（§6.1）；
 * 4. 返回拆解结果 + 批次 + 运行汇总。
 */
export async function analyzeAndRunPipeline(
  requirement: string,
  options: AnalyzeAndRunOptions,
): Promise<AnalyzeAndRunResult> {
  const splitOptions: SplitOptions = {
    parentLlm: options.parentLlm,
    parentTools: options.parentTools,
    ...(options.chat !== undefined ? { chat: options.chat } : {}),
    ...(options.split ?? {}),
    // Forward the per-role model bindings so the researcher subagent honors
    // /multi-agent role selections, not just parentLlm.
    ...(options.roleLlmConfigs !== undefined ? { roleLlmConfigs: options.roleLlmConfigs } : {}),
  };
  const splitResult = await analyzeRequirement(requirement, splitOptions);
  const specs = splitResult.specs;
  const batches = topologicalBatches(specs);
  const orchestrator = new PipelineOrchestrator(options);
  const summary = await orchestrator.run(specs, options.run);
  return { specs, batches, summary };
}

/**
 * Expose the full H3 + H4 pipeline as a single orchestrator-facing tool
 * (design §4.1 pseudocode `orchestrate(requirement)`): the LLM calls it with
 * the requirement text, and it runs split → dispatch → review → iterate
 * end to end, returning a structured JSON outcome.
 *
 * The returned tool exposes `multi_agent_pipeline` (the LLM-facing wrapper).
 */
export function createAnalyzePipelineTool(options: AnalyzeAndRunOptions): Tool {
  const orchestrator = new PipelineOrchestrator(options);
  return {
    name: "multi_agent_pipeline",
    description:
      "Run the full multi-agent development pipeline for a requirement: " +
      "split it into task specs (H3 DAG planning), dispatch each spec to a coder " +
      "subagent, validate the workspace, review with an independent reviewer " +
      "subagent, and iterate until the gates pass. Returns a structured JSON " +
      "summary of every task outcome.",
    parameters: {
      type: "object",
      properties: {
        requirement: {
          type: "string",
          description: "The requirement text to analyze and implement.",
        },
        projectContext: {
          type: "string",
          description: "Optional project background included in the split prompt.",
        },
        maxIteration: {
          type: "integer",
          minimum: 1,
          maximum: 5,
          description: "Max auto-iterations when a review gate fails. Default 3.",
        },
      },
      required: ["requirement"],
    },
    execute: async (args, signal) => {
      const requirement = String(args.requirement ?? "");
      if (!requirement.trim()) {
        return {
          content: "multi_agent_pipeline: requirement must not be empty",
          isError: true,
        };
      }
      const abortSignal = signal ?? options.signal;
      const orchestratorWithSignal = abortSignal !== undefined
        ? new PipelineOrchestrator({ ...options, signal: abortSignal })
        : orchestrator;
      const splitOptions: SplitOptions = {
        parentLlm: options.parentLlm,
        parentTools: options.parentTools,
        ...(options.chat !== undefined ? { chat: options.chat } : {}),
        ...(typeof args.projectContext === "string" && args.projectContext
          ? { projectContext: args.projectContext }
          : {}),
        ...(options.split ?? {}),
        // Forward the per-role model bindings so the researcher (H3 planner)
        // subagent honors /multi-agent role selections, not just parentLlm.
        ...(options.roleLlmConfigs !== undefined ? { roleLlmConfigs: options.roleLlmConfigs } : {}),
      };
      try {
        const splitResult = await analyzeRequirement(requirement, {
          ...splitOptions,
          ...(abortSignal !== undefined ? { signal: abortSignal } : {}),
        });
        if (abortSignal?.aborted) {
          return { content: "multi_agent_pipeline aborted", isError: true };
        }
        const specs = splitResult.specs;
        const runOptions: RunOptions = {};
        if (typeof args.maxIteration === "number" && args.maxIteration >= 1) {
          runOptions.maxIter = args.maxIteration;
        }
        if (abortSignal !== undefined) {
          runOptions.signal = abortSignal;
        }
        const summary = await orchestratorWithSignal.run(specs, runOptions);
        if (abortSignal?.aborted) {
          // The run was aborted mid-flight: report the partial summary and flag
          // the abort so the LLM knows not to interpret "ok:false" as a normal
          // failure.
          return {
            content: JSON.stringify({
              ok: false,
              aborted: true,
              specs: specs.map((spec) => spec.id),
              entries: summary.entries.map((entry) => ({
                spec: entry.spec.id,
                status: entry.result.status,
                attempts: entry.attempts,
                ...(entry.checkpoint !== undefined ? { checkpoint: entry.checkpoint } : {}),
              })),
            }, null, 2),
            isError: true,
          };
        }
        return {
          content: JSON.stringify({
            ok: summary.ok,
            specs: specs.map((spec) => spec.id),
            entries: summary.entries.map((entry) => ({
              spec: entry.spec.id,
              status: entry.result.status,
              ...(entry.verdict !== undefined ? { verdict: entry.verdict } : {}),
              attempts: entry.attempts,
              ...(entry.checkpoint !== undefined ? { checkpoint: entry.checkpoint } : {}),
            })),
          }, null, 2),
          isError: !summary.ok,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: `multi_agent_pipeline failed: ${message}`, isError: true };
      }
    },
  };
}

export { createPipelineTool };
