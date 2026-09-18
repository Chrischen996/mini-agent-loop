// H4 自我反思/验收引擎（design doc §6.1 / §6.2 / §7.1）。
//
// 独立于 `orchestrator.ts` 内联的 review 流程，用于在 subagent 回收结果后执行
// 五道门禁，并在不通过时生成修订 spec 触发闭环迭代。

import { runValidation, type ValidationReport } from "../../validation.ts";
import type { TaskSpec, WorkerResult, ReviewVerdict } from "./types.ts";

export interface ReviewGateReport {
  statusOk: boolean;
  filesInScope: boolean;
  /**
   * Result per requested hard-gate step:
   * - `true` — the script ran and passed.
   * - `false` — the script ran and failed.
   * - `undefined` — the step was skipped (no such script in the workspace);
   *   a skipped step never blocks acceptance, matching `runValidation`
   *   which silently omits unavailable `npm run <step> --if-present` scripts.
   */
  hardGates: { test?: boolean; typecheck?: boolean; build?: boolean };
  semanticPassed: boolean;
  validationReport?: ValidationReport;
}

export interface ReviewAndMergeResult {
  verdict: ReviewVerdict;
  merged: boolean;
  gateReport: ReviewGateReport;
  revisedSpec?: TaskSpec;
}

export interface ReviewAndMergeOptions {
  /** Workspace path passed to `runValidation` for the hard gates. */
  workspace: string;
  /** Which hard-gate steps to run (default: all three). */
  steps?: Array<"test" | "typecheck" | "build">;
  /** Timeout applied to each hard-gate step, ms. */
  timeoutMs?: number;
}

/**
 * 执行验收管道（§6.1），返回裁决 + 是否合并 + 是否需生成修订 spec。
 *
 * 门禁顺序：
 * 1. 状态检查：`result.status === "done"`
 * 2. 文件核对：`changed_files` 全部落在 `files_hint` 范围内
 * 3. 硬门禁：调用 `runValidation` 实际执行 test / typecheck / build（§6.2）
 * 4. 语义验收：由调用方传入的独立 reviewer verdict（避免「自己打分」）
 *
 * 全部通过 ⇒ `merged = true`。任一失败且 `iter < maxIter` ⇒ 生成修订 spec，
 * 调用方应基于 `revisedSpec` 重新派发。`iter >= maxIter` ⇒ 升级人工。
 */
export async function reviewAndMerge(
  result: WorkerResult,
  spec: TaskSpec,
  reviewerVerdict: ReviewVerdict,
  options: ReviewAndMergeOptions,
  iter: number = 1,
  maxIter: number = 3,
): Promise<ReviewAndMergeResult> {
  const statusOk = result.status === "done";
  const filesInScope = result.changed_files.every((f) =>
    (spec.files_hint ?? []).includes(f),
  );

  // Gate 3: actually run the hard gates in the workspace. `runValidation`
  // only executes steps whose npm script exists; steps with no script are
  // skipped silently and must not fail the gate.
  let validationReport: ValidationReport | undefined;
  const hardGates: ReviewGateReport["hardGates"] = {};
  if (statusOk && filesInScope) {
    validationReport = await runValidation({
      workspace: options.workspace,
      steps: options.steps,
      timeoutMs: options.timeoutMs,
    });
    for (const step of validationReport.steps) {
      hardGates[step.name] = step.ok;
    }
  }
  // Hard gate passes when every step that actually ran succeeded
  // (steps the workspace does not configure never block acceptance).
  const hardGatePassed = Object.values(hardGates).every((ok) => ok);

  const semanticPassed = reviewerVerdict.passed;

  const verdict: ReviewVerdict = {
    passed: statusOk && filesInScope && hardGatePassed && semanticPassed,
    failed_items: [
      ...(!statusOk ? [`status: ${result.status}`] : []),
      ...(!filesInScope
        ? [
            `out-of-scope files: ${result.changed_files
              .filter((f) => !(spec.files_hint ?? []).includes(f))
              .join(", ")}`,
          ]
        : []),
      ...(!hardGatePassed
        ? [
            ...(hardGates.test === false ? ["test gate failed"] : []),
            ...(hardGates.typecheck === false ? ["typecheck gate failed"] : []),
            ...(hardGates.build === false ? ["build gate failed"] : []),
          ]
        : []),
      ...(!semanticPassed ? reviewerVerdict.failed_items : []),
    ],
    suggestions: reviewerVerdict.suggestions,
  };

  const gateReport: ReviewGateReport = {
    statusOk,
    filesInScope,
    hardGates,
    semanticPassed,
    validationReport,
  };

  if (verdict.passed) {
    return { verdict, merged: true, gateReport };
  }

  if (iter >= maxIter) {
    return { verdict, merged: false, gateReport };
  }

  const revisionNote = `Fix items: ${verdict.failed_items.join("; ")}`;
  const revisedSpec: TaskSpec = {
    ...spec,
    acceptance: [
      ...spec.acceptance,
      ...(verdict.suggestions ? [`Adjust per review suggestions: ${verdict.suggestions}`] : []),
      revisionNote,
    ],
  };

  return { verdict, merged: false, gateReport, revisedSpec };
}
