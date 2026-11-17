import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  backgroundGoalNotice,
  GoalManager,
  GoalStore,
  isBackgroundGoalActive,
  launchBackgroundGoal,
  parseGoalCommand,
} from "../src/goal/index.ts";
import { SubagentTaskRegistry } from "../src/subagent/task-registry.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "goal-bg-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function makeRepo(dir: string): Promise<string> {
  const repo = path.join(dir, "repo");
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "test");
  await writeFile(path.join(repo, "file.txt"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

describe("goal --bg command parsing", () => {
  it("parses --bg and strips it from the objective", () => {
    assert.deepEqual(parseGoalCommand("/goal ship the feature --bg"), {
      kind: "set", objective: "ship the feature", background: true,
    });
    assert.deepEqual(parseGoalCommand("/goal --bg ship it"), {
      kind: "set", objective: "ship it", background: true,
    });
    assert.deepEqual(parseGoalCommand("/goal ship it --background --token-budget 500"), {
      kind: "set", objective: "ship it", tokenBudget: 500, background: true,
    });
    assert.deepEqual(parseGoalCommand("/goal ship it"), { kind: "set", objective: "ship it" });
    // A flag-looking word inside prose is not stripped.
    assert.deepEqual(parseGoalCommand("/goal discuss --bground semantics"), {
      kind: "set", objective: "discuss --bground semantics",
    });
    assert.equal(parseGoalCommand("/goal --bg")?.kind, "invalid");
  });
});

describe("background goal mutex", () => {
  it("is active only while an active goal carries a backgroundTaskId", async () => {
    await withTempDir(async (dir) => {
      const store = new GoalStore({ dataDir: dir });
      assert.equal(await isBackgroundGoalActive(store, "s1"), false, "no goal");
      await store.write({
        sessionId: "s1", goalId: "g1", objective: "x", status: "active",
        tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
      });
      assert.equal(await isBackgroundGoalActive(store, "s1"), false, "foreground goal");
      await store.update("s1", (g) => g ? { ...g, backgroundTaskId: "goal_abc" } : undefined);
      assert.equal(await isBackgroundGoalActive(store, "s1"), true, "worker-owned goal");
      await store.update("s1", (g) => g ? { ...g, status: "complete" } : undefined);
      assert.equal(await isBackgroundGoalActive(store, "s1"), false, "completed goal releases the mutex");
    });
  });

  it("releases a mutex whose registry worker is interrupted", async () => {
    await withTempDir(async (dir) => {
      const store = new GoalStore({ dataDir: dir });
      const registry = new SubagentTaskRegistry(await makeRepo(dir));
      const taskId = "sub_11111111-1111-4111-8111-111111111111";
      await store.write({
        sessionId: "s1", goalId: "g1", objective: "x", status: "active",
        tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
        backgroundTaskId: taskId,
      });
      await registry.start({
        taskId,
        ownerSessionId: "s1",
        task: "x",
        args: { task: "x", runInBackground: true },
        status: "interrupted",
        runInBackground: true,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        killed: false,
        blockWaited: false,
        completionConsumed: false,
        wakeDelivered: false,
      });

      assert.equal(await isBackgroundGoalActive(store, "s1", registry), false);
      assert.equal((await store.get("s1"))?.backgroundTaskId, undefined);
    });
  });
});


describe("launchBackgroundGoal", () => {
  it("refuses to launch outside a clean git repo and leaves no goal mutex", async () => {
    await withTempDir(async (dir) => {
      const store = new GoalStore({ dataDir: dir });
      const registry = new SubagentTaskRegistry(dir);
      await store.write({
        sessionId: "s1", goalId: "g1", objective: "x", status: "active",
        tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
      });
      await assert.rejects(
        launchBackgroundGoal({
          cwd: path.join(dir, "not-a-repo"),
          ownerSessionId: "s1",
          objective: "x",
          registry,
          store,
        }),
        /worktree isolation/,
      );
      assert.equal(await isBackgroundGoalActive(store, "s1"), false, "no mutex after refusal");
    });
  });

  it("creates a worktree, registers the task, and marks the goal worker-owned", async () => {
    await withTempDir(async (dir) => {
      const repo = await makeRepo(dir);
      const store = new GoalStore({ dataDir: dir });
      const registry = new SubagentTaskRegistry(repo);
      await store.write({
        sessionId: "s1", goalId: "g1", objective: "rename the module", status: "active",
        tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
      });
      // Fake entry: ack the IPC start handshake, log env for debugging, exit.
      const fakeEntry = path.join(dir, "fake-worker.mjs");
      await writeFile(fakeEntry, [
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(path.join(dir, "worker-env.log"))}, JSON.stringify({ argv: process.argv, execArgv: process.execArgv, cwd: process.cwd(), hasSend: typeof process.send }) + "\\n");`,
        'process.once("message", () => { process.send("ready"); setTimeout(() => process.exit(0), 50); });',
      ].join("\n") + "\n");
      const launch = await launchBackgroundGoal({
        cwd: repo,
        ownerSessionId: "s1",
        objective: "rename the module",
        registry,
        store,
        entryPoint: fakeEntry,
        execArgv: [],
      });
      assert.match(launch.taskId, /^sub_/);
      assert.match(launch.branch, /goal-/);
      assert.notEqual(launch.worktreeDir, repo, "worker never runs in the live checkout");
      const goal = await store.get("s1");
      assert.equal(goal?.backgroundTaskId, launch.taskId);
      assert.equal(goal?.worktreeBranch, launch.branch);
      assert.equal(await isBackgroundGoalActive(store, "s1"), true);
      const record = await registry.get(launch.taskId, "s1");
      assert.equal(record?.runInBackground, true);
      assert.equal(record?.ownerSessionId, "s1");
      const notice = backgroundGoalNotice(launch);
      assert.ok(notice.includes(launch.taskId));
      assert.ok(notice.includes(launch.branch));
      assert.ok(notice.includes("bypass"));
    });
  });

});

describe("model-initiated background goals (create_goal background=true)", () => {
  it("hands the goal to the launcher and reports task/worktree/branch", async () => {
    await withTempDir(async (dir) => {
      const store = new GoalStore({ dataDir: dir });
      const manager = new GoalManager({ store, sessionId: "s1" });
      const calls: Array<{ objective: string }> = [];
      const { createGoalTools } = await import("../src/goal/index.ts");
      const [, createTool] = createGoalTools(manager, {
        launchBackground: async (request) => {
          calls.push(request);
          // Simulate what launchBackgroundGoal does to the store.
          await store.update("s1", (g) => g ? { ...g, backgroundTaskId: "sub_x", worktreeDir: "/wt", worktreeBranch: "goal-b" } : undefined);
          return { taskId: "sub_x", worktreeDir: "/wt", branch: "goal-b" };
        },
      });
      const result = await createTool.execute({ objective: "long refactor", background: true });
      assert.equal(result.isError, undefined);
      const payload = JSON.parse(result.content as string);
      assert.equal(payload.background.taskId, "sub_x");
      assert.equal(payload.background.branch, "goal-b");
      assert.ok(String(payload.note).includes("Do not keep working"));
      assert.deepEqual(calls, [{ objective: "long refactor" }]);
      assert.equal(await isBackgroundGoalActive(store, "s1"), true, "mutex armed after model handoff");
    });
  });

  it("marks the goal blocked when the launcher fails (dirty repo etc.)", async () => {
    await withTempDir(async (dir) => {
      const store = new GoalStore({ dataDir: dir });
      const manager = new GoalManager({ store, sessionId: "s1" });
      const { createGoalTools } = await import("../src/goal/index.ts");
      const [, createTool] = createGoalTools(manager, {
        launchBackground: async () => { throw new Error("worktree isolation requires a clean repo"); },
      });
      const result = await createTool.execute({ objective: "x", background: true });
      assert.equal(result.isError, true);
      assert.ok(String(result.content).includes("clean repo"));
      const goal = await store.get("s1");
      assert.equal(goal?.status, "blocked");
      assert.equal(await isBackgroundGoalActive(store, "s1"), false, "no stranded mutex");
    });
  });

  it("rejects background requests when the host has no launcher", async () => {
    await withTempDir(async (dir) => {
      const store = new GoalStore({ dataDir: dir });
      const manager = new GoalManager({ store, sessionId: "s1" });
      const { createGoalTools } = await import("../src/goal/index.ts");
      const [, createTool] = createGoalTools(manager);
      const result = await createTool.execute({ objective: "x", background: true });
      assert.equal(result.isError, true);
      assert.ok(String(result.content).includes("not available"));
      assert.equal((await store.get("s1"))?.status, "blocked");
    });
  });

  it("foreground create_goal is unchanged when background is omitted", async () => {
    await withTempDir(async (dir) => {
      const store = new GoalStore({ dataDir: dir });
      const manager = new GoalManager({ store, sessionId: "s1" });
      const { createGoalTools } = await import("../src/goal/index.ts");
      const [, createTool] = createGoalTools(manager, {
        launchBackground: async () => { throw new Error("must not be called"); },
      });
      const result = await createTool.execute({ objective: "quick fix" });
      assert.equal(result.isError, undefined);
      const payload = JSON.parse(result.content as string);
      assert.equal(payload.background, undefined);
      assert.equal(payload.goal.status, "active");
    });
  });
});

describe("background goal worker environment", () => {
  it("links node_modules and copies .env into the isolated worktree", async () => {
    await withTempDir(async (dir) => {
      const repo = await makeRepo(dir);
      await mkdir(path.join(repo, "node_modules"), { recursive: true });
      await writeFile(path.join(repo, "node_modules", "package.txt"), "shared\n");
      await writeFile(path.join(repo, ".env"), "API_KEY=local\n");
      const store = new GoalStore({ dataDir: dir });
      const registry = new SubagentTaskRegistry(repo);
      await store.write({
        sessionId: "s1", goalId: "g1", objective: "x", status: "active",
        tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
      });
      const fakeEntry = path.join(dir, "fake-worker.mjs");
      await writeFile(fakeEntry, 'process.once("message", () => process.exit(0));\n');
      const launch = await launchBackgroundGoal({
        cwd: repo,
        ownerSessionId: "s1",
        objective: "x",
        registry,
        store,
        entryPoint: fakeEntry,
        execArgv: [],
      });
      const linked = await readFile(path.join(launch.worktreeDir, "node_modules", "package.txt"), "utf8");
      const copied = await readFile(path.join(launch.worktreeDir, ".env"), "utf8");
      assert.equal(linked, "shared\n");
      assert.equal(copied, "API_KEY=local\n");
    });
  });
});

describe("background goal concurrency", () => {
  it("blocks the third launch while two detached workers are active", async () => {
    await withTempDir(async (dir) => {
      const repo = await makeRepo(dir);
      const store = new GoalStore({ dataDir: dir });
      const registry = new SubagentTaskRegistry(repo);
      const fakeEntry = path.join(dir, "fake-worker.mjs");
      await writeFile(fakeEntry, [
        'await new Promise(() => {});',
        'process.once("message", () => process.exit(0));',
      ].join("\n") + "\n");
      const taskIds: string[] = [];
      for (const sessionId of ["s1", "s2"]) {
        await store.write({
          sessionId, goalId: sessionId, objective: "x", status: "active",
          tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
        });
        const launch = await launchBackgroundGoal({
          cwd: repo,
          ownerSessionId: sessionId,
          objective: "x",
          registry,
          store,
          entryPoint: fakeEntry,
          execArgv: [],
          concurrencyLimit: 2,
        });
        taskIds.push(launch.taskId);
      }

      await store.write({
        sessionId: "s3", goalId: "s3", objective: "x", status: "active",
        tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
      });
      const controller = new AbortController();
      const launchPromise = launchBackgroundGoal({
        cwd: repo,
        ownerSessionId: "s3",
        objective: "x",
        registry,
        store,
        entryPoint: fakeEntry,
        execArgv: [],
        concurrencyLimit: 2,
        concurrencySignal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort();
      await assert.rejects(launchPromise, /Operation aborted/);
      const goal = await store.get("s3");
      assert.equal(goal?.status, "blocked");
      assert.equal(goal?.backgroundTaskId, undefined);
      assert.equal((await registry.get(taskIds[0], "s1"))?.workerPid !== undefined, true);
      assert.equal((await registry.get(taskIds[1], "s2"))?.workerPid !== undefined, true);
      await registry.kill(taskIds[0], "s1");
      await registry.kill(taskIds[1], "s2");
    });
  });
});
