/**
 * Pipeline orchestrator (M1) tests — Route A in-process subagent dispatch,
 * structured WorkerResult callback, topological batch dispatch, and the
 * acceptance/review iteration loop.
 *
 * Follows the faux-LLM conventions of test/subagent.test.ts: a dummy LLM
 * config with model "faux" plus an injected faux `chat` that immediately
 * answers (no tool calls). One injected chat serves both the coder and
 * reviewer subagents; reviewer dispatches are distinguished by
 * REVIEW_VERDICT_MARKER in the prompt.
 */
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contentAsString } from "../src/content.ts";
import { makeLlmConfig, type ChatFn } from "../src/llm/index.ts";
import type { SubagentEvent } from "../src/subagent/types.ts";
import type { AgentMessage } from "../src/types.ts";
import type { Tool, ToolResult } from "../src/tools/types.ts";
import {
  buildReviewerPrompt,
  buildWorkerPrompt,
  createPipelineTool,
  enforceFileOwnership,
  PipelineOrchestrator,
  REVIEW_VERDICT_MARKER,
  topologicalBatches,
  tsxImportProbe,
  type PipelineOrchestratorOptions,
} from "../src/orchestration/pipeline/orchestrator.ts";
import type {
  PipelineLogEvent,
  TaskSpec,
  WorkerResult,
} from "../src/orchestration/pipeline/types.ts";

// ─── Shared helpers ──────────────────────────────────────────────────────────

const dummyLlm = makeLlmConfig({
  apiKey: "test-key",
  baseUrl: "http://localhost/v1",
  model: "faux",
});

/** A minimal tool for subagents to call. */
function createEchoTool(): Tool {
  return {
    name: "echo",
    description: "echoes back the input",
    parameters: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
    execute: async (args: Record<string, unknown>): Promise<ToolResult> => ({
      content: `echo: ${args.message}`,
    }),
  };
}

function makeSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "T-1",
    title: "task one",
    context: "project context",
    instruction: "implement the feature",
    acceptance: ["feature works"],
    files_hint: ["src/a.ts"],
    ...overrides,
  };
}

/** Fenced WorkerResult JSON block (the worker callback protocol). */
function workerResultText(id: string, overrides: Partial<WorkerResult> = {}): string {
  const payload: Record<string, unknown> = {
    id,
    status: "done",
    message: "done",
    changed_files: [],
    summary: "implemented",
    ...overrides,
  };
  return "```json\n" + JSON.stringify(payload) + "\n```";
}

/** Bare (unfenced) ReviewVerdict JSON — exercises the brace-scan fallback. */
function verdictText(
  passed: boolean,
  failedItems: string[] = [],
  suggestions?: string,
): string {
  return JSON.stringify({
    passed,
    failed_items: failedItems,
    ...(suggestions !== undefined ? { suggestions } : {}),
  });
}

/**
 * One faux chat that serves BOTH the coder and the reviewer subagent
 * dispatches, branching on the unique reviewer marker in the prompt.
 * Worker replies: `workerText` (constant or per-call function);
 * reviewer replies: `reviewerVerdicts` consumed in call order.
 */
function createPipelineChat(options: {
  workerText?: string | ((callIndex: number) => string);
  reviewerVerdicts?: string[];
} = {}) {
  let workerCalls = 0;
  let reviewerCalls = 0;
  const prompts: string[] = [];
  const chat: ChatFn = async (_config, messages: AgentMessage[]) => {
    const prompt = contentAsString(messages.find((m) => m.role === "user")?.content ?? "");
    prompts.push(prompt);
    if (prompt.includes(REVIEW_VERDICT_MARKER)) {
      const verdict = options.reviewerVerdicts?.[reviewerCalls] ?? verdictText(true);
      reviewerCalls += 1;
      return { role: "assistant", content: verdict };
    }
    const configured = options.workerText ?? workerResultText("T-1");
    const text = typeof configured === "function" ? configured(workerCalls) : configured;
    workerCalls += 1;
    return { role: "assistant", content: text };
  };
  return {
    chat,
    workerCalls: () => workerCalls,
    reviewerCalls: () => reviewerCalls,
    prompts: () => prompts,
  };
}

function makeOrchestrator(
  chat: ChatFn,
  extra: Partial<PipelineOrchestratorOptions> = {},
): PipelineOrchestrator {
  return new PipelineOrchestrator({
    parentLlm: dummyLlm,
    parentTools: [createEchoTool()],
    chat,
    ...extra,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────
// A single top-level describe keeps execution serial (Node runs top-level
// describe blocks concurrently by default).

describe("PipelineOrchestrator (M1)", () => {

  // ── Topological batch dispatch (design §4.5) ──────────────────────────────

  describe("topologicalBatches", () => {
    it("orders dependent specs into sequential batches", () => {
      const specs = [
        makeSpec({ id: "C", depends_on: ["B"] }),
        makeSpec({ id: "A" }),
        makeSpec({ id: "B", depends_on: ["A"] }),
      ];
      const batches = topologicalBatches(specs);
      assert.deepEqual(
        batches.map((batch) => batch.map((s) => s.id)),
        [["A"], ["B"], ["C"]],
      );
    });

    it("groups independent tasks into the same batch", () => {
      const specs = [
        makeSpec({ id: "A" }),
        makeSpec({ id: "B", depends_on: ["A"] }),
        makeSpec({ id: "C", depends_on: ["A"] }),
        makeSpec({ id: "D", depends_on: ["B", "C"] }),
      ];
      assert.deepEqual(
        topologicalBatches(specs).map((batch) => batch.map((s) => s.id)),
        [["A"], ["B", "C"], ["D"]],
      );
    });

    it("throws when a depends_on id is unknown", () => {
      assert.throws(
        () => topologicalBatches([makeSpec({ id: "A", depends_on: ["missing"] })]),
        /unknown task dependency/i,
      );
    });

    it("throws when a dependency cycle is detected", () => {
      assert.throws(
        () =>
          topologicalBatches([
            makeSpec({ id: "X", depends_on: ["Y"] }),
            makeSpec({ id: "Y", depends_on: ["X"] }),
          ]),
        /task dependency cycle detected/,
      );
    });

    it("is also available as an instance method", () => {
      const orchestrator = new PipelineOrchestrator({
        parentLlm: dummyLlm,
        parentTools: [],
      });
      assert.deepEqual(
        orchestrator.topologicalBatches([makeSpec({ id: "A" })]).map(
          (batch) => batch.map((s) => s.id),
        ),
        [["A"]],
      );
    });
  });

  // ── Prompt builders ────────────────────────────────────────────────────────

  describe("buildWorkerPrompt", () => {
    it("embeds instruction, acceptance, ownership discipline, and the output protocol", () => {
      const spec = makeSpec({
        id: "T-20",
        instruction: "add POST /login",
        acceptance: ["returns 200 + token", "401 on bad password"],
        files_hint: ["app/auth.py"],
        context: "FastAPI + JWT",
      });
      const prompt = buildWorkerPrompt(spec);
      assert.ok(prompt.includes("add POST /login"), "instruction");
      assert.ok(prompt.includes("returns 200 + token"), "acceptance 1");
      assert.ok(prompt.includes("401 on bad password"), "acceptance 2");
      assert.ok(prompt.includes("FastAPI + JWT"), "context");
      assert.ok(prompt.includes("T-20"), "spec id");
      assert.ok(prompt.includes("app/auth.py"), "files_hint");
      assert.match(prompt, /files_hint/);
      assert.match(prompt, /notes/);
      assert.match(prompt, /```json/);
      assert.ok(
        !prompt.includes(REVIEW_VERDICT_MARKER),
        "worker prompt must not carry the reviewer marker",
      );
    });
  });

  describe("buildReviewerPrompt", () => {
    it("carries the marker, the spec, the result, and the verdict protocol", () => {
      const spec = makeSpec({ id: "T-21" });
      const result: WorkerResult = {
        id: "T-21",
        status: "done",
        message: "ok",
        changed_files: [],
        summary: "done",
      };
      const prompt = buildReviewerPrompt(spec, result);
      assert.ok(prompt.includes(REVIEW_VERDICT_MARKER), "marker present");
      assert.ok(prompt.includes("T-21"), "spec id present");
      assert.match(prompt, /"passed"/);
      assert.match(prompt, /"failed_items"/);
    });

    it("checks import safety for new modules", () => {
      const spec = makeSpec({ id: "T-22", files_hint: ["src/a.ts"] });
      const result: WorkerResult = {
        id: "T-22",
        status: "done",
        message: "ok",
        changed_files: ["src/a.ts"],
        summary: "done",
      };
      const prompt = buildReviewerPrompt(spec, result);
      assert.ok(prompt.includes("Import safety"), "import-safety check present");
      assert.ok(prompt.includes("process.argv[1]"), "defensive main-guard rule present");
    });
  });

  // ── WorkerResult callback parsing ──────────────────────────────────────────

  describe("parseWorkerResult", () => {
    it("parses a fenced json block", () => {
      const result = PipelineOrchestrator.parseWorkerResult(
        workerResultText("T-1", {
          message: "大哥我做完了",
          changed_files: ["src/a.ts"],
          test_result: "5 passed",
        }),
      );
      assert.equal(result.status, "done");
      assert.equal(result.id, "T-1");
      assert.equal(result.message, "大哥我做完了");
      assert.deepEqual(result.changed_files, ["src/a.ts"]);
      assert.equal(result.test_result, "5 passed");
    });

    it("parses a bare json object without fences", () => {
      const result = PipelineOrchestrator.parseWorkerResult(
        `finished: ${JSON.stringify({ id: "T-2", status: "failed", message: "boom" })}`,
      );
      assert.equal(result.status, "failed");
      assert.equal(result.id, "T-2");
      assert.equal(result.message, "boom");
      assert.deepEqual(result.changed_files, []);
    });

    it("returns a failed result for unparseable text", () => {
      const result = PipelineOrchestrator.parseWorkerResult("no structured output at all");
      assert.equal(result.status, "failed");
      assert.equal(result.id, "");
      assert.equal(result.error, "unparseable worker result");
      assert.equal(result.message, "no structured output at all");
      assert.deepEqual(result.changed_files, []);
    });

    it("prefers the LAST fenced block when several exist", () => {
      const text =
        "```json\n" +
        JSON.stringify({ id: "T-3", status: "done" }) +
        "\n```\n```\n" +
        JSON.stringify({ id: "T-3", status: "failed", message: "regressed" }) +
        "\n```";
      const result = PipelineOrchestrator.parseWorkerResult(text);
      assert.equal(result.status, "failed");
      assert.equal(result.message, "regressed");
    });

    it("defaults status to done when the object parsed but status is missing", () => {
      const result = PipelineOrchestrator.parseWorkerResult(
        JSON.stringify({ id: "T-4", summary: "just worked" }),
      );
      assert.equal(result.status, "done");
      assert.equal(result.id, "T-4");
      assert.deepEqual(result.changed_files, []);
    });
  });

  // ── dispatch ───────────────────────────────────────────────────────────────

  describe("dispatch", () => {
    it("returns the parsed worker callback with attempt=1", async () => {
      const { chat } = createPipelineChat({
        workerText: workerResultText("T-10", {
          changed_files: ["src/a.ts"],
          summary: "implemented the feature",
        }),
      });
      const orchestrator = makeOrchestrator(chat);
      const result = await orchestrator.dispatch(makeSpec({ id: "T-10" }));
      assert.equal(result.status, "done");
      assert.equal(result.id, "T-10");
      assert.equal(result.attempt, 1);
      assert.deepEqual(result.changed_files, ["src/a.ts"]);
      assert.equal(result.summary, "implemented the feature");
    });

    it("returns a failed status when the worker reply is unparseable", async () => {
      const { chat } = createPipelineChat({
        workerText: "I tried several things but produced no structured output",
      });
      const orchestrator = makeOrchestrator(chat);
      const result = await orchestrator.dispatch(makeSpec({ id: "T-11" }));
      assert.equal(result.status, "failed");
      assert.equal(result.id, "T-11");
      assert.equal(result.error, "unparseable worker result");
      assert.equal(result.attempt, 1);
    });

    it("tracks the per-task attempt counter across dispatches", async () => {
      const { chat } = createPipelineChat({
        workerText: workerResultText("T-12", { status: "failed", message: "first try" }),
      });
      const orchestrator = makeOrchestrator(chat);
      const spec = makeSpec({ id: "T-12" });
      assert.equal((await orchestrator.dispatch(spec)).attempt, 1);
      assert.equal((await orchestrator.dispatch(spec)).attempt, 2);
    });
  });

  // ── dispatchAll (failure propagation, design §4.5) ────────────────────────

  describe("dispatchAll", () => {
    it("blocks transitive dependents when an upstream task fails", async () => {
      const a = makeSpec({ id: "A" });
      const b = makeSpec({ id: "B", depends_on: ["A"] });
      const c = makeSpec({ id: "C", depends_on: ["B"] });
      const events: PipelineLogEvent[] = [];
      const { chat } = createPipelineChat({
        workerText: workerResultText("A", { status: "failed", message: "could not complete" }),
      });
      const orchestrator = makeOrchestrator(chat, {
        onEvent: (event) => events.push(event),
      });

      const results = await orchestrator.dispatchAll([a, b, c]);

      assert.equal(results.length, 3);
      assert.equal(results[0]!.status, "failed");
      assert.equal(results[1]!.status, "blocked");
      assert.equal(results[1]!.id, "B");
      assert.equal(results[2]!.status, "blocked");
      assert.equal(results[2]!.id, "C");
      // A was dispatched; B and C were blocked without being dispatched.
      assert.ok(events.some((e) => e.event === "dispatch" && e.task_id === "A"));
      assert.ok(!events.some((e) => e.event === "dispatch" && e.task_id === "B"));
      assert.ok(!events.some((e) => e.event === "dispatch" && e.task_id === "C"));
      assert.ok(events.some((e) => e.event === "fail" && e.task_id === "B" && e.status === "blocked"));
    });

    it("returns results in the original spec order on success", async () => {
      const specs = [
        makeSpec({ id: "X" }),
        makeSpec({ id: "Y", depends_on: ["X"] }),
        makeSpec({ id: "Z" }),
      ];
      // Echo each task's id back in the callback so result order is checkable.
      const echoChat: ChatFn = async (_config, messages: AgentMessage[]) => {
        const prompt = contentAsString(
          messages.find((m) => m.role === "user")?.content ?? "",
        );
        const id = prompt.match(/^Task (\S+):/m)?.[1] ?? "unknown";
        return { role: "assistant", content: workerResultText(id) };
      };
      const orchestrator = makeOrchestrator(echoChat);
      const results = await orchestrator.dispatchAll(specs);
      assert.deepEqual(results.map((r) => r.id), ["X", "Y", "Z"]);
      assert.ok(results.every((r) => r.status === "done"));
    });
  });

  // ── run (acceptance loop, design §6/§7) ───────────────────────────────────

  describe("run", () => {
    it("re-dispatches with feedback and passes on the second attempt", async () => {
      const spec = makeSpec({ id: "T-30" });
      const { chat, workerCalls, reviewerCalls, prompts } = createPipelineChat({
        workerText: workerResultText("T-30"),
        reviewerVerdicts: [
          verdictText(false, ["acceptance item 1: feature works"], "implement the feature"),
          verdictText(true),
        ],
      });
      const orchestrator = makeOrchestrator(chat);
      const summary = await orchestrator.run([spec]);

      assert.equal(summary.ok, true);
      assert.equal(summary.entries.length, 1);
      const entry = summary.entries[0]!;
      assert.equal(entry.spec.id, "T-30");
      assert.equal(entry.result.status, "done");
      assert.equal(entry.attempts, 2, "two dispatches before the review passed");
      assert.equal(entry.verdict?.passed, true);
      assert.equal(workerCalls(), 2);
      assert.equal(reviewerCalls(), 2);
      // The second (revision) worker dispatch carried the feedback.
      const revisionPrompt = prompts().find((p) =>
        p.includes("## Previous attempt feedback"),
      );
      assert.ok(revisionPrompt, "revision dispatch must carry attempt feedback");
      assert.ok(
        revisionPrompt!.includes("acceptance item 1: feature works"),
        "feedback must include the failed items",
      );
    });

    it("marks the task failed when maxIter is exhausted", async () => {
      const { chat, workerCalls, reviewerCalls } = createPipelineChat({
        workerText: workerResultText("T-31"),
        reviewerVerdicts: [verdictText(false, ["still broken"])],
      });
      const orchestrator = makeOrchestrator(chat);
      const summary = await orchestrator.run([makeSpec({ id: "T-31" })], {
        maxIter: 1,
      });

      assert.equal(summary.ok, false);
      const entry = summary.entries[0]!;
      assert.equal(entry.attempts, 1);
      assert.equal(entry.result.status, "failed", "exhausted run records the task as failed");
      assert.equal(entry.verdict?.passed, false);
      assert.equal(workerCalls(), 1);
      assert.equal(reviewerCalls(), 1);
    });

    it("blocks a spec whose upstream task failed the review", async () => {
      const a = makeSpec({ id: "P" });
      const b = makeSpec({ id: "Q", depends_on: ["P"] });
      const { chat, workerCalls } = createPipelineChat({
        workerText: workerResultText("P"),
        reviewerVerdicts: [verdictText(false, ["never passes"])],
      });
      const orchestrator = makeOrchestrator(chat);
      const summary = await orchestrator.run([a, b], { maxIter: 1 });
      assert.equal(summary.ok, false);
      assert.equal(summary.entries[0]!.result.status, "failed");
      assert.equal(summary.entries[1]!.result.status, "blocked");
      assert.equal(summary.entries[1]!.attempts, 0, "blocked specs are never dispatched");
      assert.equal(workerCalls(), 1, "Q must not have been dispatched");
    });
  });

  // ── event log (design §5.8) ───────────────────────────────────────────────

  describe("event log", () => {
    it("emits dispatch / done / callback for a successful dispatch", async () => {
      const events: PipelineLogEvent[] = [];
      const { chat } = createPipelineChat({
        workerText: workerResultText("T-40", { changed_files: ["src/a.ts"] }),
      });
      const orchestrator = makeOrchestrator(chat, {
        onEvent: (event) => events.push(event),
      });
      const result = await orchestrator.dispatch(makeSpec({ id: "T-40" }));
      assert.equal(result.status, "done");
      const taskEvents = events.filter((e) => e.task_id === "T-40");
      assert.deepEqual(
        taskEvents.map((e) => e.event),
        ["dispatch", "done", "callback"],
      );
      assert.equal(taskEvents.find((e) => e.event === "dispatch")?.attempt, 1);
    });

    it("emits dispatch / fail / callback for an unparseable worker reply", async () => {
      const events: PipelineLogEvent[] = [];
      const { chat } = createPipelineChat({
        workerText: "garbage reply without any json",
      });
      const orchestrator = makeOrchestrator(chat, {
        onEvent: (event) => events.push(event),
      });
      const result = await orchestrator.dispatch(makeSpec({ id: "T-41" }));
      assert.equal(result.status, "failed");
      assert.deepEqual(
        events.filter((e) => e.task_id === "T-41").map((e) => e.event),
        ["dispatch", "fail", "callback"],
      );
    });

    it("emits the full event sequence for a two-attempt run", async () => {
      const events: PipelineLogEvent[] = [];
      const { chat } = createPipelineChat({
        workerText: workerResultText("T-42"),
        reviewerVerdicts: [verdictText(false, ["first review fails"]), verdictText(true)],
      });
      const orchestrator = makeOrchestrator(chat, {
        onEvent: (event) => events.push(event),
      });
      const summary = await orchestrator.run([makeSpec({ id: "T-42" })]);
      assert.equal(summary.ok, true);
      assert.deepEqual(
        events.filter((e) => e.task_id === "T-42").map((e) => e.event),
        [
          "dispatch",
          "done",
          "callback",
          "review_fail",
          "retry",
          "dispatch",
          "done",
          "callback",
          "review_pass",
          "merge",
        ],
      );
      const dispatches = events.filter((e) => e.event === "dispatch");
      assert.deepEqual(
        dispatches.map((e) => e.attempt),
        [1, 2],
      );
    });
  });

  // ─── validation & checkpoint auto-discovery (design §6.1 / §7.1) ─────────

  describe("validation & checkpoint auto-discovery", () => {
    it("auto-detects a failing validate_workspace tool and marks the task failed", async () => {
      const { chat } = createPipelineChat({
        workerText: workerResultText("T-50"),
        reviewerVerdicts: [verdictText(true)],
      });
      const failingValidate: Tool = {
        name: "validate_workspace",
        description: "failing validator",
        parameters: { type: "object", properties: {} },
        execute: async (): Promise<ToolResult> => ({
          content: "typecheck failed: 3 errors",
          isError: true,
        }),
      };
      const orchestrator = new PipelineOrchestrator({
        parentLlm: dummyLlm,
        parentTools: [createEchoTool(), failingValidate],
        chat,
      });
      const summary = await orchestrator.run([makeSpec({ id: "T-50" })], { maxIter: 1 });
      assert.equal(summary.ok, false);
      assert.equal(summary.entries[0].result.status, "failed");
      assert.equal(summary.entries[0].attempts, 1);
      assert.deepEqual(
        orchestrator.events.filter((e) => e.event === "tool_call").map((e) => e.tool),
        ["validate_workspace"],
      );
    });

    it("captures a git_checkpoint when a task passes the gates", async () => {
      const { chat } = createPipelineChat({
        workerText: workerResultText("T-53"),
        reviewerVerdicts: [verdictText(true)],
      });
      const checkpointTool: Tool = {
        name: "git_checkpoint",
        description: "captures a checkpoint",
        parameters: { type: "object", properties: {} },
        execute: async (): Promise<ToolResult> => ({
          content: JSON.stringify({ checkpointId: "ckpt-abc" }),
        }),
      };
      const orchestrator = new PipelineOrchestrator({
        parentLlm: dummyLlm,
        parentTools: [createEchoTool(), checkpointTool],
        chat,
      });
      const summary = await orchestrator.run([makeSpec({ id: "T-53" })]);
      assert.equal(summary.ok, true);
      assert.equal(summary.entries[0].checkpoint, "ckpt-abc");
      const merge = orchestrator.events.find((e) => e.event === "merge");
      assert.equal(merge?.checkpoint, "ckpt-abc");
    });

    it("writes JSONL event logs to logDir", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pipeline-log-"));
      try {
        const { chat } = createPipelineChat({ workerText: workerResultText("T-51") });
        const orchestrator = makeOrchestrator(chat, { logDir: dir });
        await orchestrator.dispatch(makeSpec({ id: "T-51" }));
        await orchestrator.flushLogs();
        const lines = readFileSync(join(dir, "T-51.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.deepEqual(
          lines.map((line) => line.event),
          ["dispatch", "done", "callback"],
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    // ─── LLM-invokable tool wrapper ───────────────────────────────────────────

    describe("createPipelineTool", () => {
      it("returns a merged outcome for a passing spec", async () => {
        const { chat } = createPipelineChat({
          workerText: workerResultText("T-52"),
          reviewerVerdicts: [verdictText(true)],
        });
        const tool = createPipelineTool({
          parentLlm: dummyLlm,
          parentTools: [createEchoTool()],
          chat,
        });
        const result = await tool.execute({ spec: makeSpec({ id: "T-52" }) });
        assert.equal(result.isError, false);
        const parsed = JSON.parse(contentAsString(result.content)) as Record<string, unknown>;
        assert.equal(parsed.status, "merged");
        assert.equal(parsed.iterations, 1);
      });

      it("rejects a spec missing required fields", async () => {
        const { chat } = createPipelineChat();
        const tool = createPipelineTool({
          parentLlm: dummyLlm,
          parentTools: [createEchoTool()],
          chat,
        });
        const result = await tool.execute({ spec: { id: "X" } as never });
        assert.equal(result.isError, true);
        assert.match(contentAsString(result.content), /invalid spec/);
      });
    });
  });

  // ─── M3: file ownership & parallelism (design §4.7 / §8) ─────────────────

  describe("enforceFileOwnership", () => {
    it("serializes tasks with overlapping files_hint into separate waves", () => {
      const a = makeSpec({ id: "A", files_hint: ["src/a.ts"] });
      const b = makeSpec({ id: "B", files_hint: ["src/b.ts"] });
      const c = makeSpec({ id: "C", files_hint: ["src/a.ts", "src/c.ts"] });
      const waves = enforceFileOwnership([a, b, c]);
      assert.deepEqual(
        waves.map((wave) => wave.map((s) => s.id)),
        [
          ["A", "B"],
          ["C"],
        ],
      );
    });

    it("keeps dependent tasks in separate waves even without file overlap", () => {
      const a = makeSpec({ id: "A", files_hint: ["src/a.ts"] });
      const b = makeSpec({ id: "B", files_hint: ["src/b.ts"], depends_on: ["A"] });
      const waves = enforceFileOwnership([a, b]);
      assert.deepEqual(
        waves.map((wave) => wave.map((s) => s.id)),
        [
          ["A"],
          ["B"],
        ],
      );
    });

    it("leaves independent tasks without files_hint in one wave", () => {
      const a = makeSpec({ id: "A", files_hint: [] });
      const b = makeSpec({ id: "B", files_hint: [] });
      const waves = enforceFileOwnership([a, b]);
      assert.deepEqual(
        waves.map((wave) => wave.map((s) => s.id)),
        [["A", "B"]],
      );
    });
  });

  describe("parallel dispatch (maxConcurrency)", () => {
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms));

    /** Worker replies WITHOUT an id (dispatch backfills spec.id). */
    const workerDoneJson =
      "```json\n" +
      JSON.stringify({ status: "done", changed_files: [], summary: "ok" }) +
      "\n```";

    /** Faux chat that measures peak in-flight subagent conversations. */
    function createPeakTrackingChat(
      workerText: string,
      verdict: string,
      holdMs: number,
    ): { chat: ChatFn; peak: () => number } {
      let active = 0;
      let peak = 0;
      const chat: ChatFn = async (_config, messages) => {
        const prompt = contentAsString(
          messages.find((m) => m.role === "user")?.content ?? "",
        );
        active += 1;
        peak = Math.max(peak, active);
        await sleep(holdMs);
        active -= 1;
        return {
          role: "assistant",
          content: prompt.includes(REVIEW_VERDICT_MARKER) ? verdict : workerText,
        };
      };
      return { chat, peak: () => peak };
    }

    it("runs tasks in parallel up to maxConcurrency", async () => {
      const { chat, peak } = createPeakTrackingChat(
        workerDoneJson,
        verdictText(true),
        50,
      );
      const orchestrator = new PipelineOrchestrator({
        parentLlm: dummyLlm,
        parentTools: [createEchoTool()],
        chat,
        maxConcurrency: 2,
      });
      const results = await orchestrator.dispatchAll([
        makeSpec({ id: "P-1", files_hint: [] }),
        makeSpec({ id: "P-2", files_hint: [] }),
        makeSpec({ id: "P-3", files_hint: [] }),
      ]);
      assert.deepEqual(results.map((r) => r.id), ["P-1", "P-2", "P-3"]);
      assert.equal(peak(), 2);
    });

    it("is serial by default (M1 behavior)", async () => {
      const { chat, peak } = createPeakTrackingChat(
        workerDoneJson,
        verdictText(true),
        20,
      );
      const orchestrator = new PipelineOrchestrator({
        parentLlm: dummyLlm,
        parentTools: [createEchoTool()],
        chat,
      });
      await orchestrator.dispatchAll([
        makeSpec({ id: "S-1", files_hint: [] }),
        makeSpec({ id: "S-2", files_hint: [] }),
      ]);
      assert.equal(peak(), 1);
    });

    it("run() executes independent tasks in parallel and keeps original order", async () => {
      const { chat, peak } = createPeakTrackingChat(
        workerDoneJson,
        verdictText(true),
        30,
      );
      const orchestrator = new PipelineOrchestrator({
        parentLlm: dummyLlm,
        parentTools: [createEchoTool()],
        chat,
        maxConcurrency: 3,
      });
      const summary = await orchestrator.run([
        makeSpec({ id: "R-1", files_hint: [] }),
        makeSpec({ id: "R-2", files_hint: [] }),
        makeSpec({ id: "R-3", files_hint: [] }),
      ]);
      assert.equal(summary.ok, true);
      assert.deepEqual(
        summary.entries.map((e) => e.spec.id),
        ["R-1", "R-2", "R-3"],
      );
      assert.equal(peak(), 3);
    });

    it("run() blocks dependents when an upstream task fails under concurrency", async () => {
      const failedWorker =
        "```json\n" +
        JSON.stringify({ status: "failed", message: "boom", changed_files: [] }) +
        "\n```";
      const { chat } = createPeakTrackingChat(failedWorker, verdictText(true), 10);
      const orchestrator = new PipelineOrchestrator({
        parentLlm: dummyLlm,
        parentTools: [createEchoTool()],
        chat,
        maxConcurrency: 2,
      });
      const summary = await orchestrator.run(
        [
          makeSpec({ id: "A", files_hint: [] }),
          makeSpec({ id: "B", files_hint: [], depends_on: ["A"] }),
        ],
        { maxIter: 1 },
      );
      assert.equal(summary.ok, false);
      assert.equal(summary.entries[0].result.status, "failed");
      assert.equal(summary.entries[0].attempts, 1);
      assert.equal(summary.entries[1].result.status, "blocked");
      assert.equal(summary.entries[1].attempts, 0);
    });
  });

  // ─── cost control & observability (design §9) ───────────────────────

  describe("cost control & observability", () => {
    it("forwards subagent lifecycle events via onSubagentEvent", async () => {
      const { chat } = createPipelineChat({ workerText: workerResultText("T-60") });
      const subagentEvents: SubagentEvent[] = [];
      const orchestrator = makeOrchestrator(chat, {
        onSubagentEvent: (event) => subagentEvents.push(event),
      });
      await orchestrator.dispatch(makeSpec({ id: "T-60" }));
      const start = subagentEvents.find(
        (e): e is Extract<SubagentEvent, { type: "subagent_start" }> =>
          e.type === "subagent_start",
      );
      const end = subagentEvents.find(
        (e): e is Extract<SubagentEvent, { type: "subagent_end" }> =>
          e.type === "subagent_end",
      );
      assert.ok(start !== undefined, "subagent_start expected");
      assert.ok(end !== undefined, "subagent_end expected");
      assert.equal(end.success, true);
      assert.equal(start.id, end.id);
    });

    it("accepts token-budget options without changing a successful run", async () => {
      const { chat } = createPipelineChat({
        workerText: workerResultText("T-61"),
        reviewerVerdicts: [verdictText(true)],
      });
      const orchestrator = makeOrchestrator(chat, {
        workerTokenBudget: 1_000_000,
        reviewerTokenBudget: 1_000_000,
        globalTokenBudget: 10_000_000,
      });
      const summary = await orchestrator.run([makeSpec({ id: "T-61" })], { maxIter: 1 });
      assert.equal(summary.ok, true);
      assert.equal(summary.entries[0].result.status, "done");
    });
  });

  // ─── import safety gate (design §6.2 hardening) ───────────────────

  describe("import safety gate", () => {
    const existingModule = "src/orchestration/pipeline/types.ts";

    it("is off by default", async () => {
      const { chat } = createPipelineChat({
        workerText: workerResultText("T-70", { changed_files: [existingModule] }),
        reviewerVerdicts: [verdictText(true)],
      });
      const orchestrator = makeOrchestrator(chat);
      const spec = makeSpec({ id: "T-70", files_hint: [existingModule] });
      const result = await orchestrator.dispatch(spec);
      const verdict = await orchestrator.review(result, spec);
      assert.equal(verdict.passed, true);
    });

    it("custom probe failure fails the review with an import-safety item", async () => {
      const { chat } = createPipelineChat({
        workerText: workerResultText("T-71", { changed_files: [existingModule] }),
        reviewerVerdicts: [verdictText(true)],
      });
      const probeCalls: string[] = [];
      const orchestrator = makeOrchestrator(chat, {
        importSafetyProbe: async (file) => {
          probeCalls.push(file);
          return { ok: false, detail: "crash on import" };
        },
      });
      const spec = makeSpec({ id: "T-71", files_hint: [existingModule] });
      const result = await orchestrator.dispatch(spec);
      const verdict = await orchestrator.review(result, spec);
      assert.equal(verdict.passed, false);
      assert.ok(
        verdict.failed_items.some((item) => item.includes(`import safety: ${existingModule}`)),
        `failed_items: ${verdict.failed_items.join("; ")}`,
      );
      assert.deepEqual(probeCalls, [existingModule]);
    });

    it("skips the probe for non-importable file types", async () => {
      const { chat } = createPipelineChat({
        workerText: workerResultText("T-72", { changed_files: ["package.json"] }),
        reviewerVerdicts: [verdictText(true)],
      });
      let probeCalls = 0;
      const orchestrator = makeOrchestrator(chat, {
        importSafetyProbe: async () => {
          probeCalls += 1;
          return { ok: true };
        },
      });
      const spec = makeSpec({ id: "T-72", files_hint: ["package.json"] });
      const result = await orchestrator.dispatch(spec);
      const verdict = await orchestrator.review(result, spec);
      assert.equal(probeCalls, 0);
      assert.equal(verdict.passed, true);
    });

    it("built-in tsxImportProbe passes for a clean module", async () => {
      const outcome = await tsxImportProbe(process.cwd(), existingModule);
      assert.equal(outcome.ok, true);
    });

    it("built-in tsxImportProbe reports a module that crashes on import", async () => {
      const dirName = `.import-probe-${process.pid}`;
      const dir = join(process.cwd(), dirName);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "broken.ts"), "export const x = 1;\nthrow new Error('boom');\n");
      try {
        const outcome = await tsxImportProbe(process.cwd(), join(dirName, "broken.ts"));
        assert.equal(outcome.ok, false);
        assert.match(outcome.detail ?? "", /boom/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
