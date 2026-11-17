import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  attachGoalDiagnostics,
  classifySteering,
  createGoalLog,
  createGoalSession,
  GoalStore,
  isGoalLogEnabled,
  resolveGoalLogPath,
} from "../src/goal/index.ts";
import type { AgentMessage } from "../src/types.ts";

type Entry = { event: string; [key: string]: unknown };

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "goal-diag-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readEntries(file: string): Promise<Entry[]> {
  const raw = await readFile(file, "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Entry);
}

describe("goal diagnostics opt-in", () => {
  it("is disabled unless explicitly enabled", () => {
    assert.equal(isGoalLogEnabled({}), false);
    assert.equal(isGoalLogEnabled({ MINI_AGENT_GOAL_LOG: "0" }), false);
    assert.equal(isGoalLogEnabled({ MINI_AGENT_GOAL_LOG: "1" }), true);
    assert.equal(isGoalLogEnabled({ MINI_AGENT_GOAL_LOG: "true" }), true);
    assert.equal(createGoalLog("s1", {}), undefined, "no logger and no filesystem work when off");
  });

  it("honors an explicit log path and sanitizes the session id otherwise", () => {
    assert.equal(
      resolveGoalLogPath("abc", { MINI_AGENT_GOAL_LOG_PATH: "/tmp/x.jsonl" }),
      "/tmp/x.jsonl",
    );
    const derived = resolveGoalLogPath("../../etc/passwd", { AGENT_DATA_DIR: "/tmp/data" });
    assert.ok(!derived.includes(".."), "path traversal is neutralized");
    assert.ok(derived.endsWith(".jsonl"));
    // Compare against the resolved root: macOS maps /tmp to /private/tmp.
    assert.ok(derived.startsWith(path.join(path.resolve("/tmp/data"), "goal-logs") + path.sep));
    assert.ok(!derived.includes("etc/passwd"), "traversal segments are flattened into the filename");
  });

  it("writes JSONL with timestamps and never throws on an unwritable path", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "nested", "goal.jsonl");
      const log = createGoalLog("sess-1", { MINI_AGENT_GOAL_LOG: "1", MINI_AGENT_GOAL_LOG_PATH: file });
      assert.ok(log);
      log.log({ event: "custom", extra: 42 });
      const entries = await readEntries(file);
      assert.equal(entries[0]!.event, "log_opened");
      assert.equal(entries[1]!.event, "custom");
      assert.equal(entries[1]!.extra, 42);
      assert.equal(entries[1]!.sessionId, "sess-1");
      assert.ok(typeof entries[1]!.ts === "number");
      assert.ok(typeof entries[1]!.iso === "string");

      // A path whose parent is a file cannot be created; logging must stay silent.
      const blocked = createGoalLog("s", {
        MINI_AGENT_GOAL_LOG: "1",
        MINI_AGENT_GOAL_LOG_PATH: path.join(file, "child.jsonl"),
      });
      assert.ok(blocked);
      blocked.log({ event: "should_not_throw" });
    });
  });

  it("classifies steering by exact signature, not by keyword", async () => {
    const { goalCreatedPrompt, continuationPrompt, objectiveUpdatedPrompt, budgetLimitPrompt } =
      await import("../src/goal/steering.ts");
    const goal = {
      sessionId: "s", goalId: "g", objective: "ship it", status: "active" as const,
      tokenBudget: 500, tokensUsed: 120, timeUsedSeconds: 3, createdAt: 1, updatedAt: 1,
    };
    assert.equal(classifySteering(undefined), "unknown");
    assert.equal(classifySteering(goalCreatedPrompt(goal)), "goal_created");
    assert.equal(classifySteering(objectiveUpdatedPrompt(goal)), "objective_updated");
    assert.equal(classifySteering(budgetLimitPrompt(goal)), "budget_limit");
    // Regression: every prompt carries a "Budget:" block, so a keyword match
    // used to mislabel continuations as budget_limit.
    assert.equal(classifySteering(continuationPrompt(goal)), "continuation");
  });
});

describe("goal diagnostics capture", () => {
  it("logs creation, steering injection, usage, and continuation decisions", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "goal.jsonl");
      const session = createGoalSession({
        enabled: true,
        sessionId: "diag-1",
        store: new GoalStore({ dataDir: dir }),
        maxContinuations: 1,
      });
      const seen: string[] = [];
      attachGoalDiagnostics(session, {
        log: createGoalLog("diag-1", { MINI_AGENT_GOAL_LOG: "1", MINI_AGENT_GOAL_LOG_PATH: file }),
        onEvent: (event) => seen.push(event.reason),
        onGoalSnapshot: (goal) => seen.push(`snapshot:${goal?.status ?? "null"}`),
      });

      await session.manager.createFromModel("ship the pixel borders", 100);
      const history: AgentMessage[] = [
        { role: "system", content: "system" },
        { role: "user", content: "go" },
      ];
      const prepared = await session.runtime.prepareMessages(history);
      assert.ok(prepared.length > history.length, "steering was injected");

      await session.runtime.chargeTokens({ totalTokens: 40 });
      assert.ok(await session.runtime.shouldContinue(), "first continuation allowed");
      assert.equal(await session.runtime.shouldContinue(), undefined, "cap reached");
      await session.runtime.finish();

      const entries = await readEntries(file);
      const kinds = entries.map((entry) => entry.event);
      for (const expected of ["goal_updated", "steering_prepare", "goal_snapshot", "continuation_decision", "turn_finished"]) {
        assert.ok(kinds.includes(expected), `missing ${expected}`);
      }

      const steering = entries.find((entry) => entry.event === "steering_prepare")!;
      assert.equal(steering.injected, true);
      assert.equal(steering.steeringKind, "goal_created");
      assert.equal(steering.messagesBefore, 2);
      assert.equal(steering.messagesAfter, 3);

      const decisions = entries.filter((entry) => entry.event === "continuation_decision");
      assert.equal(decisions.length, 2);
      assert.equal(decisions[0]!.continued, true);
      assert.equal(decisions[1]!.continued, false);
      assert.equal(decisions[1]!.stopReason, "goal_not_active_or_continuation_cap");

      // Original callbacks must still fire: diagnostics may not swallow them.
      assert.ok(seen.includes("created"), "manager event callback preserved");
      assert.ok(seen.some((value) => value.startsWith("snapshot:")), "snapshot callback preserved");
    });
  });

  it("records that no steering was injected when there is no goal", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "goal.jsonl");
      const session = createGoalSession({
        enabled: true,
        sessionId: "diag-2",
        store: new GoalStore({ dataDir: dir }),
      });
      attachGoalDiagnostics(session, {
        log: createGoalLog("diag-2", { MINI_AGENT_GOAL_LOG: "1", MINI_AGENT_GOAL_LOG_PATH: file }),
      });
      await session.runtime.prepareMessages([{ role: "user", content: "hello" }]);
      const entries = await readEntries(file);
      const steering = entries.find((entry) => entry.event === "steering_prepare")!;
      assert.equal(steering.injected, false);
      assert.equal(steering.steeringKind, "none");
    });
  });

  it("does not double-wrap when attached twice", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "goal.jsonl");
      const session = createGoalSession({
        enabled: true,
        sessionId: "diag-3",
        store: new GoalStore({ dataDir: dir }),
      });
      const options = {
        log: createGoalLog("diag-3", { MINI_AGENT_GOAL_LOG: "1", MINI_AGENT_GOAL_LOG_PATH: file }),
      };
      attachGoalDiagnostics(session, options);
      attachGoalDiagnostics(session, options);
      await session.runtime.prepareMessages([{ role: "user", content: "hi" }]);
      const entries = await readEntries(file);
      assert.equal(
        entries.filter((entry) => entry.event === "steering_prepare").length,
        1,
        "one prepare call produces exactly one log line",
      );
    });
  });

  it("leaves runtime behavior untouched when logging is disabled", async () => {
    await withTempDir(async (dir) => {
      const session = createGoalSession({
        enabled: true,
        sessionId: "diag-4",
        store: new GoalStore({ dataDir: dir }),
      });
      const originalPrepare = session.runtime.prepareMessages;
      attachGoalDiagnostics(session, { log: undefined });
      assert.equal(session.runtime.prepareMessages, originalPrepare, "no wrapper installed");
      await session.manager.createFromModel("objective");
      const prepared = await session.runtime.prepareMessages([{ role: "user", content: "go" }]);
      assert.equal(prepared.length, 2, "steering still injected normally");
    });
  });
});
