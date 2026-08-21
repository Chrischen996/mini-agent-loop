import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  JobManager,
  JobStore,
  MemoryStore,
  createPauseGate,
  createWorkOrder,
  runPlannerWorkerReviewer,
  canTransitionJob,
  SessionExecutionGate,
} from "../src/orchestration/index.ts";

describe("orchestration primitives", () => {
  it("serializes session execution and rejects stale or duplicate releases", () => {
    const gate = new SessionExecutionGate();
    const first = gate.tryAcquire("session", "message");
    assert.ok(first);
    assert.equal(gate.isBusy("session"), true);
    assert.equal(gate.tryAcquire("session", "job"), undefined);
    assert.equal(gate.release({ ...first }), false);
    assert.equal(gate.release(first), true);
    assert.equal(gate.release(first), false);
    const second = gate.tryAcquire("session", "job");
    assert.equal(second?.owner, "job");
    assert.equal(gate.isBusy("other-session"), false);
  });

  it("enforces the job lifecycle transition table", () => {
    assert.equal(canTransitionJob("queued", "running"), true);
    assert.equal(canTransitionJob("running", "paused"), true);
    assert.equal(canTransitionJob("waiting_approval", "completed"), true);
    assert.equal(canTransitionJob("paused", "completed"), true);
    assert.equal(canTransitionJob("completed", "running"), false);
  });

  it("pauses and resumes cooperative work", async () => {
    const gate = createPauseGate();
    gate.pause();
    let released = false;
    const waiting = gate.wait().then(() => { released = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(released, false);
    gate.resume();
    await waiting;
    assert.equal(released, true);
  });

  it("persists, restores, and marks interrupted jobs for explicit retry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "orchestration-jobs-"));
    try {
      const store = new JobStore(root);
      const first = new JobManager(store);
      const created = await first.create({ sessionId: "session", task: "long task" });
      await first.start(created.id, async () => {
        await new Promise(() => undefined);
      });
      const restored = new JobManager(store);
      await restored.restore();
      assert.equal(restored.get(created.id)?.status, "failed");
      assert.match(restored.get(created.id)?.error ?? "", /process restart/);
      await restored.retry(created.id);
      assert.equal(restored.get(created.id)?.status, "queued");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires a fresh runner for retry instead of retaining a failed runner closure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "orchestration-runner-"));
    try {
      const manager = new JobManager(new JobStore(root));
      const job = await manager.create({ sessionId: "session", task: "retry task" });
      let executions = 0;
      const failed = new Promise<void>((resolve) => {
        const stop = manager.onChange((current) => {
          if (current.id === job.id && current.status === "failed") {
            stop();
            resolve();
          }
        });
      });
      await manager.start(job.id, async () => {
        executions += 1;
        throw new Error("first runner failed");
      });
      await failed;
      await manager.retry(job.id);

      const completed = new Promise<void>((resolve) => {
        const stop = manager.onChange((current) => {
          if (current.id === job.id && current.status === "completed") {
            stop();
            resolve();
          }
        });
      });
      await manager.start(job.id, async () => {
        executions += 1;
        return "recovered";
      });
      await completed;
      assert.equal(executions, 2);
      assert.equal(manager.get(job.id)?.result, "recovered");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps memory candidates out of prompts until confirmed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "orchestration-memory-"));
    try {
      const store = new MemoryStore(path.join(root, "records.json"));
      const candidate = await store.add({ scope: "project", key: "test", content: "Use node:test" });
      assert.equal(await store.buildPrompt("test"), "");
      await store.confirm(candidate.id);
      assert.match(await store.buildPrompt("test"), /Use node:test/);
      await store.forget(candidate.id);
      assert.equal(await store.buildPrompt("test"), "");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs bounded planner, worker, reviewer, and rework handoffs", async () => {
    const calls: string[] = [];
    let reviewerContext = "";
    const state = await runPlannerWorkerReviewer({
      goal: "implement feature",
      workspace: "/workspace",
      acceptanceCriteria: ["tests pass"],
      maxReworks: 1,
      collectEvidence: async () => ({
        changedFiles: ["src/feature.ts"],
        validation: ["typecheck: PASS"],
        evidence: ["diff: feature"],
      }),
      invoke: async ({ profile, sharedContext }) => {
        calls.push(profile);
        if (profile === "researcher") return "step one\nstep two";
        if (profile === "coder") return "changed files";
        reviewerContext = sharedContext;
        return calls.filter((item) => item === "reviewer").length === 1 ? "REWORK: add tests" : "PASS: tests pass";
      },
    });
    assert.equal(state.stage, "completed");
    assert.equal(state.reworkCount, 1);
    assert.deepEqual(calls, ["researcher", "coder", "reviewer", "coder", "reviewer"]);
    assert.deepEqual(state.workerReport?.changedFiles, ["src/feature.ts"]);
    assert.deepEqual(state.workerReport?.validation, ["typecheck: PASS"]);
    assert.deepEqual(state.reviewReport?.evidence, ["diff: feature"]);
    assert.match(reviewerContext, /src\/feature\.ts/);
    assert.equal(createWorkOrder({
      goal: "goal",
      plan: [],
      acceptanceCriteria: [],
      workerProfile: "coder",
      reviewerProfile: "reviewer",
      workspace: "/workspace",
      constraints: [],
    }).goal, "goal");
  });

  it("blocks an unstructured reviewer response instead of treating it as approval", async () => {
    const state = await runPlannerWorkerReviewer({
      goal: "implement feature",
      workspace: "/workspace",
      acceptanceCriteria: ["tests pass"],
      invoke: async ({ profile }) => profile === "reviewer" ? "The review is inconclusive." : "done",
    });
    assert.equal(state.stage, "blocked");
    assert.equal(state.reviewReport?.decision, "blocked");
  });
});
