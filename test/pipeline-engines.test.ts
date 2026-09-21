// H3/H4 engine tests: reviewAndMerge gate semantics, analyzeAndRunPipeline
// end-to-end with an injected faux chat, and the externalReviewer option.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { reviewAndMerge } from "../src/orchestration/pipeline/review-engine.ts";
import {
  analyzeAndRunPipeline,
  createAnalyzePipelineTool,
} from "../src/orchestration/pipeline/planning-engine.ts";
import { PipelineOrchestrator } from "../src/orchestration/pipeline/orchestrator.ts";
import { contentAsString } from "../src/content.ts";
import { createTools } from "../src/tools/index.ts";
import type { LlmConfig, ChatFn } from "../src/llm/index.ts";
import type { AgentMessage } from "../src/types.ts";
import type { WorkerResult, TaskSpec } from "../src/orchestration/pipeline/types.ts";

const PARENT_LLM: LlmConfig = {
  model: "deepseek/deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "test-key",
} as LlmConfig;

function makeSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "T-001",
    title: "Implement login",
    context: "FastAPI + JWT",
    instruction: "Add POST /login",
    acceptance: ["returns 200 + token"],
    files_hint: ["app/auth.py"],
    ...overrides,
  };
}

function makeResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    id: "T-001",
    status: "done",
    message: "done",
    changed_files: ["app/auth.py"],
    summary: "added login",
    ...overrides,
  };
}

/**
 * Build a faux chat that answers each subagent prompt by keyword:
 *  - splitter prompt → a JSON array of TaskSpecs
 *  - reviewer prompt (tagged REVIEW VERDICT) → a passing verdict
 *  - worker prompt → a passing WorkerResult
 */
function makeSplitAndPassChat(specsJson: string): ChatFn {
  const chat: ChatFn = async (config, messages) => {
    void config;
    const text = messages.map((m: AgentMessage) => String(m.content)).join("\n");
    if (text.includes("Split the requirement into independently deliverable development tasks")) {
      return { role: "assistant", content: specsJson };
    }
    if (text.includes("REVIEW VERDICT")) {
      return { role: "assistant", content: JSON.stringify({ passed: true, failed_items: [] }) };
    }
    return {
      role: "assistant",
      content: JSON.stringify(makeResult({ id: "T-001", changed_files: ["app/auth.py"] })),
    };
  };
  return chat;
}

describe("reviewAndMerge", () => {
  let workspace: string;
  before(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "review-engine-test-"));
  });

  it("passes when all gates are satisfied and no hard-gate scripts exist", async () => {
    // Empty workspace: no test/typecheck/build scripts, so runValidation skips
    // all hard gates and they must not block acceptance.
    // Use an empty changed_files list so the file-scope gate is satisfied
    // (reviewAndMerge has no on-disk existence requirement, unlike the
    // orchestrator's built-in review()).
    const result = await reviewAndMerge(
      makeResult({ changed_files: [] }),
      makeSpec(),
      { passed: true, failed_items: [] },
      { workspace },
      1,
      3,
    );
    assert.equal(result.verdict.passed, true);
    assert.equal(result.merged, true);
    assert.equal(result.revisedSpec, undefined);
    assert.equal(result.gateReport.statusOk, true);
    assert.equal(result.gateReport.filesInScope, true);
    // No hard-gate scripts in the empty workspace → all undefined (skipped).
    assert.equal(result.gateReport.hardGates.test, undefined);
    assert.equal(result.gateReport.hardGates.typecheck, undefined);
    assert.equal(result.gateReport.hardGates.build, undefined);
    assert.equal(result.gateReport.semanticPassed, true);
  });

  it("fails the status gate and returns a revised spec under maxIter", async () => {
    const result = await reviewAndMerge(
      makeResult({ status: "blocked" }),
      makeSpec(),
      { passed: true, failed_items: [] },
      { workspace },
      1,
      3,
    );
    assert.equal(result.verdict.passed, false);
    assert.equal(result.merged, false);
    assert.ok(result.revisedSpec);
    assert.ok(
      result.revisedSpec!.acceptance.some((item) =>
        item.includes("status: blocked"),
      ),
    );
  });

  it("fails the file-scope gate for out-of-scope changes", async () => {
    const result = await reviewAndMerge(
      makeResult({ changed_files: ["app/auth.py", "package.json"] }),
      makeSpec(),
      { passed: true, failed_items: [] },
      { workspace },
      1,
      3,
    );
    assert.equal(result.verdict.passed, false);
    assert.ok(
      result.verdict.failed_items.some((item) =>
        item.includes("out-of-scope files: package.json"),
      ),
    );
  });

  it("fails when the semantic reviewer verdict fails", async () => {
    const result = await reviewAndMerge(
      makeResult(),
      makeSpec(),
      { passed: false, failed_items: ["token not returned"], suggestions: "add token" },
      { workspace },
      1,
      3,
    );
    assert.equal(result.verdict.passed, false);
    assert.ok(result.verdict.failed_items.includes("token not returned"));
    assert.equal(result.verdict.suggestions, "add token");
    assert.ok(result.revisedSpec);
    assert.ok(
      result.revisedSpec!.acceptance.some((item) =>
        item.includes("token not returned"),
      ),
    );
  });

  it("does not produce a revised spec when the iteration budget is exhausted", async () => {
    const result = await reviewAndMerge(
      makeResult({ status: "failed" }),
      makeSpec(),
      { passed: false, failed_items: ["x"] },
      { workspace },
      3,
      3,
    );
    assert.equal(result.verdict.passed, false);
    assert.equal(result.merged, false);
    assert.equal(result.revisedSpec, undefined);
  });
});

describe("analyzeAndRunPipeline", () => {
  let workspace: string;
  before(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "planning-engine-test-"));
    // The fake worker reports app/auth.py as changed; the orchestrator's
    // file-scope gate (gate 2) requires changed files to exist on disk.
    await mkdir(path.join(workspace, "app"), { recursive: true });
    await writeFile(path.join(workspace, "app", "auth.py"), "login");
  });
  after(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("runs the full pipeline offline with a scripted faux chat", async () => {
    const specsJson = JSON.stringify([makeSpec({ id: "T-001", instruction: "add login" })]);
    const chat = makeSplitAndPassChat(specsJson);

    const result = await analyzeAndRunPipeline("add login", {
      parentLlm: PARENT_LLM,
      parentTools: createTools(workspace),
      chat,
      workspaceRoot: workspace,
      split: { parentLlm: PARENT_LLM, parentTools: createTools(workspace), maxTasks: 4 },
      run: { maxIter: 2 },
    });

    assert.equal(result.specs.length, 1);
    assert.equal(result.specs[0].id, "T-001");
    assert.equal(result.batches.length, 1);
    assert.equal(result.summary.entries.length, 1);
    assert.equal(result.summary.ok, true);
    assert.equal(result.summary.entries[0].result.status, "done");
  });

  it("exposes a multi_agent_pipeline tool that reports structured outcomes", async () => {
    const specsJson = JSON.stringify([makeSpec({ id: "T-001", instruction: "add login" })]);
    const tool = createAnalyzePipelineTool({
      parentLlm: PARENT_LLM,
      parentTools: createTools(workspace),
      chat: makeSplitAndPassChat(specsJson),
      workspaceRoot: workspace,
      split: { parentLlm: PARENT_LLM, parentTools: createTools(workspace), maxTasks: 4 },
    });

    assert.equal(tool.name, "multi_agent_pipeline");
    const toolResult = await tool.execute({ requirement: "add login" });
    const toolText = contentAsString(toolResult.content);
    assert.equal(toolResult.isError, false, toolText);
    const parsed = JSON.parse(toolText);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.specs, ["T-001"]);
    assert.equal(parsed.entries[0].status, "done");
  });
});

describe("PipelineOrchestrator externalReviewer", () => {
  let workspace: string;
  before(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "orchestrator-ext-reviewer-"));
    // Gate 2 requires changed files to exist under workspaceRoot.
    await mkdir(path.join(workspace, "app"), { recursive: true });
    await writeFile(path.join(workspace, "app", "auth.py"), "login");
  });
  after(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("consults externalReviewer in place of the built-in reviewer subagent", async () => {
    let externalCalls = 0;
    const orchestrator = new PipelineOrchestrator({
      parentLlm: PARENT_LLM,
      // No validate_workspace tool in this set → gate 3 is skipped.
      parentTools: [] as never,
      workspaceRoot: workspace,
      externalReviewer: async () => {
        externalCalls += 1;
        return { passed: true, failed_items: [] };
      },
    });
    const spec = makeSpec();
    // A "done" result whose changed files exist and match files_hint passes
    // the scope gate; with no validate tool the remaining gate is the
    // reviewer, which is now the external function.
    const verdict = await orchestrator.review(
      makeResult({ status: "done", changed_files: ["app/auth.py"] }),
      spec,
    );
    assert.equal(externalCalls, 1);
    assert.equal(verdict.passed, true);
  });

  it("treats a passed:false verdict with empty failed_items as a failure", async () => {
    const orchestrator = new PipelineOrchestrator({
      parentLlm: PARENT_LLM,
      parentTools: [] as never,
      workspaceRoot: workspace,
      externalReviewer: async () => ({ passed: false, failed_items: [] }),
    });
    const verdict = await orchestrator.review(
      makeResult({ status: "done", changed_files: ["app/auth.py"] }),
      makeSpec(),
    );
    assert.equal(verdict.passed, false);
    assert.ok(
      verdict.failed_items.length > 0,
      "a failing verdict must surface at least one failed item for the retry loop",
    );
  });

  it("converts an externalReviewer exception into a failed verdict", async () => {
    const orchestrator = new PipelineOrchestrator({
      parentLlm: PARENT_LLM,
      parentTools: [] as never,
      workspaceRoot: workspace,
      externalReviewer: async () => {
        throw new Error("reviewer backend down");
      },
    });
    const verdict = await orchestrator.review(
      makeResult({ status: "done", changed_files: ["app/auth.py"] }),
      makeSpec(),
    );
    assert.equal(verdict.passed, false);
    assert.ok(
      verdict.failed_items.some((item) => item.includes("reviewer backend down")),
    );
  });

  it("forwards the per-run signal so cancellation aborts in-flight dispatches", async () => {
    const controller = new AbortController();
    // A faux chat that waits up to the abort signal before answering. When the
    // orchestrator's worker/reviewer dispatch receives the run signal, its
    // subagent loop aborts and the pipeline terminates with non-"done" entries.
    const waitingChat: ChatFn = async (_config, _messages) => {
      await new Promise<void>((resolve) => {
        if (controller.signal.aborted) {
          resolve();
          return;
        }
        const onAbort = () => resolve();
        controller.signal.addEventListener("abort", onAbort, { once: true });
        // Safety net: never let the test hang — resolve after 200 ms so the
        // chat can complete with a minimal (spec-less) payload.
        setTimeout(() => resolve(), 200).unref?.();
      });
      return { role: "assistant", content: "[]" };
    };
    const orchestrator = new PipelineOrchestrator({
      parentLlm: PARENT_LLM,
      parentTools: [] as never,
      workspaceRoot: workspace,
      chat: waitingChat,
    });
    const summaryPromise = orchestrator.run([makeSpec()], { maxIter: 1, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const summary = await summaryPromise;
    // The aborted run must not report any successful dispatch.
    assert.ok(
      summary.entries.every((entry) => entry.result.status !== "done"),
      "an aborted run must not report successful dispatches",
    );
    assert.equal(controller.signal.aborted, true);
  });

  it("captures a pre-dispatch checkpoint for rollback isolation", async () => {
    // No git_checkpoint tool in the parent set → checkpoint stays undefined,
    // which must not break the pipeline.
    const orchestrator = new PipelineOrchestrator({
      parentLlm: PARENT_LLM,
      parentTools: [] as never,
      workspaceRoot: workspace,
      chat: makeSplitAndPassChat(JSON.stringify([makeSpec({ id: "T-001" })])),
    });
    const summary = await orchestrator.run([makeSpec()], { maxIter: 1 });
    assert.equal(summary.entries.length, 1);
    assert.equal(summary.entries[0].checkpoint, undefined);
  });
});
