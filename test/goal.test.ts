import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { makeLlmConfig } from "../src/llm/index.ts";
import { runAgentTurn } from "../src/loop.ts";
import type { AgentMessage } from "../src/types.ts";
import {
  createGoalSession,
  createGoalTools,
  GoalManager,
  GoalStore,
  goalSnapshot,
  parseGoalCommand,
  resolveGoalConfig,
} from "../src/goal/index.ts";

async function withTempStore(callback: (store: GoalStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "mini-agent-goals-"));
  try {
    await callback(new GoalStore({ dataDir: dir }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function managerWith(store: GoalStore, sessionId = "s1"): GoalManager {
  return new GoalManager({ store, sessionId });
}

describe("GoalStore", () => {
  it("round-trips a goal and tolerates corrupt files", async () => {
    await withTempStore(async (store) => {
      assert.equal(await store.get("s1"), undefined);
      const goal = {
        sessionId: "s1",
        goalId: "g1",
        objective: "fix the build",
        status: "active" as const,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      };
      await store.write(goal);
      assert.deepEqual(await store.get("s1"), goal);

      const goalFile = path.join((store as unknown as { root: string }).root, "s1.json");
      await writeFile(goalFile, "{not json", { flag: "w" });
      assert.equal(await store.get("s1"), undefined);

      assert.equal(await store.clear("s1"), true);
      assert.equal(await store.get("s1"), undefined);
    });
  });
});

describe("GoalManager", () => {
  it("creates, updates, and clears goals with usage accounting", async () => {
    await withTempStore(async (store) => {
      const manager = managerWith(store);
      const created = await manager.createFromModel("ship it", 100);
      assert.equal(created.status, "active");
      assert.equal(created.tokenBudget, 100);
      assert.equal(goalSnapshot(created).remainingTokens, 100);

      await assert.rejects(manager.createFromModel("another"), /unfinished goal/);

      assert.equal((await manager.updateFromModel("paused")).rejected, false);
      assert.equal((await manager.updateFromModel("active")).rejected, true);
      assert.equal((await manager.updateFromModel("complete")).rejected, false);

      await manager.setFromUser({ status: "active" });
      const limited = await manager.accountUsage(100, 5);
      assert.equal(limited?.status, "budget_limited");
      assert.equal(limited?.tokensUsed, 100);
      assert.equal(limited?.timeUsedSeconds, 5);

      assert.equal(await manager.accountUsage(50, 0), undefined);

      await manager.setFromUser({ clear: true });
      assert.equal(await manager.get(), undefined);
    });
  });

  it("emits goal events on state transitions", async () => {
    await withTempStore(async (store) => {
      const events: string[] = [];
      const manager = new GoalManager({
        store,
        sessionId: "s1",
        onEvent: (event) => events.push(event.reason),
      });
      await manager.createFromModel("objective");
      assert.deepEqual(events, ["created"]);
      await manager.updateFromModel("complete");
      assert.deepEqual(events, ["created", "status_changed"]);
      await manager.setFromUser({ objective: "revised", status: "active" });
      assert.deepEqual(events, ["created", "status_changed", "status_changed"]);
      assert.equal(manager.takeSteeringIntent(), "created");
    });
  });

  it("respects the max goal token budget ceiling", async () => {
    await withTempStore(async (store) => {
      const manager = new GoalManager({ store, sessionId: "s1", maxGoalTokenBudget: 10 });
      await assert.rejects(manager.createFromModel("objective", 11), /exceeds the maximum/);
      const created = await manager.createFromModel("objective", 10);
      assert.equal(created.tokenBudget, 10);
    });
  });
});

describe("goal tools", () => {
  it("expose get/create/update with validated args and error results", async () => {
    await withTempStore(async (store) => {
      const manager = managerWith(store);
      const [getTool, createTool, updateTool] = createGoalTools(manager);
      assert.equal(getTool.name, "get_goal");
      assert.equal(createTool.name, "create_goal");
      assert.equal(updateTool.name, "update_goal");

      const empty = await getTool.execute({});
      assert.equal(empty.isError, undefined);
      assert.equal(JSON.parse(empty.content as string).goal, null);

      const created = await createTool.execute({ objective: "  do the thing " });
      assert.equal(created.isError, undefined);
      assert.equal(JSON.parse(created.content as string).goal?.objective, "do the thing");

      const badObjective = await createTool.execute({ objective: "   " });
      assert.equal(badObjective.isError, true);

      const badStatus = await updateTool.execute({ status: "active" } as never);
      assert.equal(badStatus.isError, true);
      assert.match(badStatus.content as string, /complete, blocked, or paused/);

      const completed = await updateTool.execute({ status: "complete" } as never);
      assert.equal(completed.isError, undefined);
      assert.equal(JSON.parse(completed.content as string).goal?.status, "complete");
    });
  });
});

describe("goal config", () => {
  it("resolves the goal feature flag (default-on) and budget ceilings", () => {
    assert.equal(resolveGoalConfig({}).enabled, true);
    assert.equal(resolveGoalConfig({ MINI_AGENT_GOALS: "0" } as unknown as NodeJS.ProcessEnv).enabled, false);
    assert.equal(resolveGoalConfig({ MINI_AGENT_GOALS: "off" } as unknown as NodeJS.ProcessEnv).enabled, false);
    const config = resolveGoalConfig({
      MINI_AGENT_GOALS: "1",
      MINI_AGENT_GOAL_MAX_TOKEN_BUDGET: "5000",
      MINI_AGENT_GOAL_MAX_CONTINUATIONS: "3",
    } as unknown as NodeJS.ProcessEnv);
    assert.equal(config.enabled, true);
    assert.equal(config.maxGoalTokenBudget, 5000);
    assert.equal(config.maxContinuations, 3);
  });
});

describe("goal command parsing", () => {
  it("parses /goal subcommands and token budgets", () => {
    assert.deepEqual(parseGoalCommand("/goal"), { kind: "status" });
    assert.deepEqual(parseGoalCommand("/goal clear"), { kind: "clear" });
    assert.deepEqual(parseGoalCommand("/goal pause"), { kind: "status-change", status: "paused" });
    assert.deepEqual(parseGoalCommand("/goal resume"), { kind: "status-change", status: "active" });
    assert.deepEqual(parseGoalCommand("/goal complete"), { kind: "status-change", status: "complete" });
    assert.deepEqual(
      parseGoalCommand("/goal fix the flaky test --token-budget 9000"),
      { kind: "set", objective: "fix the flaky test", tokenBudget: 9000 },
    );
    assert.equal(parseGoalCommand("/read x"), undefined);
  });
});

describe("goal runtime steering", () => {
  it("injects created steering, prunes on the next call, and continues while active", async () => {
    await withTempStore(async (store) => {
      const session = createGoalSession({ enabled: true, sessionId: "s1", store });
      await session.manager.createFromModel("ship the release");
      const runtime = session.runtime;
      runtime.beginTurn();

      const first = await runtime.prepareMessages([{ role: "user", content: "hi" }]);
      assert.match(first.at(-1)!.content as string, /ship the release/);

      const second = await runtime.prepareMessages(first);
      assert.equal(second.length, 1);

      const continuation = await runtime.shouldContinue();
      assert.ok(continuation);
      assert.equal(continuation.isContinuation, false);
      const third = await runtime.prepareMessages([{ role: "user", content: "hi" }]);
      assert.match(third.at(-1)!.content as string, /Continue working toward the active thread goal/);

      await session.manager.updateFromModel("complete");
      assert.equal(await runtime.shouldContinue(), undefined);
      assert.equal(await runtime.isActive(), false);
    });
  });

  it("distinguishes created from edited objective steering", async () => {
    await withTempStore(async (store) => {
      const session = createGoalSession({ enabled: true, sessionId: "s1", store });
      await session.manager.setFromUser({ objective: "original" });
      const runtime = session.runtime;
      runtime.beginTurn();
      const first = await runtime.prepareMessages([{ role: "user", content: "hi" }]);
      assert.match(first.at(-1)!.content as string, /A goal was created for this thread/);

      runtime.beginTurn();
      await session.manager.setFromUser({ objective: "revised" });
      const second = await runtime.prepareMessages([{ role: "user", content: "hi" }]);
      assert.match(second.at(-1)!.content as string, /objective was edited by the user/);
    });
  });

  it("caps automatic continuations", async () => {
    await withTempStore(async (store) => {
      const session = createGoalSession({ enabled: true, sessionId: "s1", maxContinuations: 2, store });
      await session.manager.createFromModel("objective");
      const runtime = session.runtime;
      runtime.beginTurn();
      assert.ok(await runtime.shouldContinue());
      assert.ok(await runtime.shouldContinue());
      assert.equal(await runtime.shouldContinue(), undefined);
    });
  });
});

describe("goal loop integration", () => {
  const llm = makeLlmConfig({ apiKey: "test-key", baseUrl: "http://localhost/v1", model: "faux" });

  it("charges usage to the goal and stops continuations when the budget is exhausted", async () => {
    await withTempStore(async (store) => {
      const session = createGoalSession({ enabled: true, sessionId: "budget-session", store });
      const goal = await session.manager.createFromModel("long goal", 50);
      const history: AgentMessage[] = [{ role: "system", content: "system" }, { role: "user", content: "go" }];
      const events: import("../src/loop.ts").LoopEvent[] = [];
      const chat: import("../src/llm/index.ts").ChatFn = async (_config, _messages) => {
        const message = { role: "assistant" as const, content: "done" };
        (message as unknown as { usage?: unknown }).usage = { totalTokens: 60, inputTokens: 30, completionTokens: 30, promptTokens: 30 };
        return message;
      };
      await runAgentTurn(history, "go", {
        llm,
        tools: session.tools,
        chat,
        goalRuntime: session.runtime,
        onEvent: (event: import("../src/loop.ts").LoopEvent) => events.push(event),
      } as never);

      const persisted = await store.get("budget-session");
      assert.equal(persisted?.status, "budget_limited");
      assert.ok(persisted!.tokensUsed >= 60);
      const goalEvents = events.filter((event) => event.type === "goal_updated");
      assert.ok(goalEvents.some((event) => event.type === "goal_updated" && event.reason === "budget_limited"));
      assert.equal(goal.goalId, persisted!.goalId);
    });
  });

  it("continues an unbounded active goal automatically and injects steering", async () => {
    await withTempStore(async (store) => {
      const session = createGoalSession({ enabled: true, sessionId: "continue-session", maxContinuations: 2, store });
      await session.manager.createFromModel("keep going");
      const seen: string[] = [];
      let finals = 0;
      const chat: import("../src/llm/index.ts").ChatFn = async (_config, messages) => {
        const last = [...messages].reverse().find((message) => message.role === "user");
        if (last && typeof last.content === "string") seen.push(last.content);
        finals += 1;
        return { role: "assistant", content: `final ${finals}` };
      };
      const history: AgentMessage[] = [{ role: "system", content: "system" }, { role: "user", content: "go" }];
      const result = await runAgentTurn(history, "go", {
        llm,
        tools: session.tools,
        chat,
        goalRuntime: session.runtime,
      } as never);
      // Main turn plus two capped continuations, each final text distinct.
      assert.equal(finals, 3);
      assert.equal(result.at(-1)?.role === "assistant" ? result.at(-1)!.content : "", "final 3");
      assert.ok(seen.some((entry) => entry.includes("Continue working toward the active thread goal")));
      assert.equal((await store.get("continue-session"))?.status, "active");
    });
  });
});
