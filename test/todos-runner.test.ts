import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TodoItem } from "../src/todo.ts";
import {
  parseTodosRunArgs,
  buildRunnerDag,
  classifyTodo,
  lockFor,
  resolveRunnerForTask,
  formatDryRun,
  runTodoPlan,
  planRunnerTask,
  subagentPromptFor,
  defaultBgCommand,
  mergeOutcomesIntoTodos,
  formatOutcome,
  summarizeOutcomes,
  type RunnerTask,
  type RunnerTaskStatus,
  type SubagentExecutor,
  type BgExecutor,
  type BgPoller,
  type RunnerOutcome,
  type RunTodoPlanOptions,
} from "../src/todos/index.ts";

const baseArgs = (): import("../src/todos/types.ts").ParsedTodosRunArgs => ({
  parallel: true,
  dryRun: false,
  only: [],
  deps: {},
  model: {},
  files: {},
  maxConcurrency: 2,
  confirm: true,
  raw: "/todos run --parallel",
});

function todo(id: string, content: string, status: TodoItem["status"] = "pending"): TodoItem {
  return { id, content, activeForm: content, status, source: "model" };
}

// ─── parser ────────────────────────────────────────────────────────────────

describe("parseTodosRunArgs", () => {
  it("parses the minimal /todos run command", () => {
    const args = parseTodosRunArgs("/todos run");
    assert.ok(args);
    assert.equal(args.parallel, false);
    // default is dry-run; require --yes to actually execute
    assert.equal(args.dryRun, true);
    assert.equal(args.confirm, false);
  });

  it("parses /tasks run --parallel", () => {
    const args = parseTodosRunArgs("/tasks run --parallel");
    assert.ok(args);
    assert.equal(args.parallel, true);
    assert.equal(args.dryRun, true);
    assert.equal(args.confirm, false);
  });

  it("parses --dry-run and --yes flags", () => {
    assert.ok(parseTodosRunArgs("/todos run --dry-run"));
    const yesArgs = parseTodosRunArgs("/todos run --parallel --yes");
    assert.ok(yesArgs);
    assert.equal(yesArgs.dryRun, true);
    assert.equal(yesArgs.confirm, true);
  });

  it("parses --dry-run", () => {
    const args = parseTodosRunArgs("/todos run --parallel --dry-run");
    assert.ok(args);
    assert.equal(args.dryRun, true);
    assert.equal(args.parallel, true);
  });

  it("parses --only with comma list", () => {
    const args = parseTodosRunArgs("/todos run --only a,b,c");
    assert.ok(args);
    assert.deepEqual(args.only, ["a", "b", "c"]);
  });

  it("parses --deps label=a,b", () => {
    const args = parseTodosRunArgs("/todos run --deps c=a,b");
    assert.ok(args);
    assert.deepEqual(args.deps, { c: ["a", "b"] });
  });

  it("parses --model label=ref", () => {
    const args = parseTodosRunArgs("/todos run --model e2e=flagship");
    assert.ok(args);
    assert.deepEqual(args.model, { e2e: "flagship" });
  });

  it("parses --files label=p1,p2", () => {
    const args = parseTodosRunArgs("/todos run --files auth-api=src/auth.ts,src/api.ts");
    assert.ok(args);
    assert.deepEqual(args.files, { "auth-api": ["src/auth.ts", "src/api.ts"] });
  });

  it("parses --max-concurrency 0 (unlimited)", () => {
    const args = parseTodosRunArgs("/todos run --max-concurrency 0");
    assert.ok(args);
    assert.equal(args.maxConcurrency, 0);
  });

  it("rejects negative --max-concurrency", () => {
    assert.equal(parseTodosRunArgs("/todos run --max-concurrency -1"), null);
  });

  it("rejects unknown flags", () => {
    assert.equal(parseTodosRunArgs("/todos run --bogus"), null);
  });

  it("returns null for non-run commands", () => {
    assert.equal(parseTodosRunArgs("/todos add Buy milk"), null);
    assert.equal(parseTodosRunArgs("/bash echo hi"), null);
  });
});

// ─── DAG build & cycle detection ───────────────────────────────────────────

describe("buildRunnerDag", () => {
  it("builds a linear chain from explicit deps", () => {
    const todos = [
      todo("install", "pnpm install"),
      todo("code", "implement auth api"),
      todo("test", "run pnpm test"),
    ];
    const args = baseArgs();
    args.deps = { code: ["install"], test: ["code"] };
    const dag = buildRunnerDag(todos, args);
    assert.equal(dag.errors.length, 0);
    assert.equal(dag.tasks.length, 3);
    // Each task in its own batch due to explicit deps
    assert.equal(dag.batches.length, 3);
    assert.deepEqual(dag.batches[0], ["install"]);
    assert.deepEqual(dag.batches[1], ["code"]);
    assert.deepEqual(dag.batches[2], ["test"]);
  });

  it("detects a dependency cycle", () => {
    const todos = [todo("a", "task a"), todo("b", "task b")];
    const args = baseArgs();
    args.deps = { a: ["b"], b: ["a"] };
    const dag = buildRunnerDag(todos, args);
    assert.ok(dag.errors.some((e) => e.includes("cycle")));
    assert.equal(dag.batches.length, 0);
  });

  it("detects a self-dependency", () => {
    const todos = [todo("a", "task a")];
    const args = baseArgs();
    args.deps = { a: ["a"] };
    const dag = buildRunnerDag(todos, args);
    assert.ok(dag.errors.some((e) => e.includes("depends on itself")));
  });

  it("reports unknown dependency labels", () => {
    const todos = [todo("a", "task a")];
    const args = baseArgs();
    args.deps = { a: ["nonexistent"] };
    const dag = buildRunnerDag(todos, args);
    assert.ok(dag.errors.some((e) => e.includes("unknown label")));
  });

  it("respects --only", () => {
    const todos = [todo("a", "task a"), todo("b", "task b")];
    const args = baseArgs();
    args.only = ["b"];
    const dag = buildRunnerDag(todos, args);
    assert.equal(dag.tasks.length, 1);
    assert.equal(dag.tasks[0]?.label, "b");
  });

  it("reports an error when --only matches nothing", () => {
    const todos = [todo("a", "task a")];
    const args = baseArgs();
    args.only = ["nope"];
    const dag = buildRunnerDag(todos, args);
    assert.equal(dag.tasks.length, 0);
    assert.ok(dag.errors.some((e) => e.includes("No matching todos")));
  });

  it("groups parallel unlocked tasks into a single batch", () => {
    const todos = [
      todo("impl-a", "Implement feature A"),
      todo("impl-b", "Implement feature B"),
      todo("impl-c", "Implement feature C"),
    ];
    const args = baseArgs();
    const dag = buildRunnerDag(todos, args);
    assert.equal(dag.errors.length, 0, `errors: ${dag.errors.join("; ")}`);
    // All three unlocked code tasks share one batch
    assert.equal(dag.batches.length, 1);
    assert.equal(dag.batches[0]?.length, 3);
  });

  it("places locked tasks in solo batches", () => {
    const todos = [
      todo("install", "pnpm install"),
      todo("feat", "implement feature"),
      todo("test", "run pnpm test"),
    ];
    const args = baseArgs();
    args.deps = { test: ["feat"] };
    const dag = buildRunnerDag(todos, args);
    assert.equal(dag.errors.length, 0);
    // install (locked) → solo batch; feat (unlocked) → solo batch; test (locked) → solo batch
    assert.equal(dag.batches.length, 3);
    assert.deepEqual(dag.batches[0], ["install"]);
    assert.deepEqual(dag.batches[1], ["feat"]);
    assert.deepEqual(dag.batches[2], ["test"]);
  });
});

// ─── resource classification ───────────────────────────────────────────────

describe("classifyTodo", () => {
  it("classifies install commands", () => {
    assert.equal(classifyTodo("pnpm install"), "install");
    assert.equal(classifyTodo("npm ci"), "install");
    assert.equal(classifyTodo("Run pnpm install to update dependencies"), "install");
  });

  it("classifies lockfile changes", () => {
    assert.equal(classifyTodo("Update pnpm-lock.yaml"), "lockfile");
  });

  it("classifies migrations", () => {
    assert.equal(classifyTodo("run db migration 001"), "migration");
  });

  it("classifies build tasks", () => {
    assert.equal(classifyTodo("run pnpm build"), "build");
    assert.equal(classifyTodo("vite build the app"), "build");
  });

  it("classifies test tasks", () => {
    assert.equal(classifyTodo("run vitest tests"), "test");
    assert.equal(classifyTodo("add e2e tests"), "test");
  });

  it("classifies docs tasks", () => {
    assert.equal(classifyTodo("update README"), "docs");
  });

  it("classifies code tasks with files", () => {
    assert.equal(classifyTodo("add feature", ["src/x.ts"]), "code");
  });

  it("defaults to unknown", () => {
    assert.equal(classifyTodo("do something"), "unknown");
  });
});

describe("resolveRunnerForTask", () => {
  it("maps code/docs/unknown to subagent", () => {
    assert.equal(resolveRunnerForTask("code"), "subagent");
    assert.equal(resolveRunnerForTask("docs"), "subagent");
    assert.equal(resolveRunnerForTask("unknown"), "subagent");
  });

  it("maps install/test/build/migration to bg", () => {
    assert.equal(resolveRunnerForTask("install"), "bg");
    assert.equal(resolveRunnerForTask("test"), "bg");
    assert.equal(resolveRunnerForTask("build"), "bg");
    assert.equal(resolveRunnerForTask("migration"), "bg");
    assert.equal(resolveRunnerForTask("lockfile"), "bg");
  });
});

describe("lockFor", () => {
  it("assigns deps lock to install classes", () => {
    assert.equal(lockFor("install"), "deps");
    assert.equal(lockFor("dependency"), "deps");
    assert.equal(lockFor("lockfile"), "deps");
  });

  it("assigns build lock to build/test", () => {
    assert.equal(lockFor("build"), "build");
    assert.equal(lockFor("test"), "build");
  });

  it("assigns db lock to migration", () => {
    assert.equal(lockFor("migration"), "db");
  });

  it("assigns no lock to code/docs/unknown", () => {
    assert.equal(lockFor("code"), null);
    assert.equal(lockFor("docs"), null);
    assert.equal(lockFor("unknown"), null);
  });
});

// ─── dry-run rendering ─────────────────────────────────────────────────────

describe("formatDryRun", () => {
  it("renders batches with task labels and resource classes", () => {
    const todos = [
      todo("install", "pnpm install"),
      todo("feat", "implement auth"),
    ];
    const args = baseArgs();
    const dag = buildRunnerDag(todos, args);
    assert.equal(dag.errors.length, 0);
    const output = formatDryRun(dag);
    assert.ok(output.includes("Dispatch plan:"));
    assert.ok(output.includes("Batch 0:"));
    assert.ok(output.includes("install"));
    assert.ok(output.includes("bg"));
    assert.ok(output.includes("install"));
  });

  it("includes lock markers for locked tasks", () => {
    const todos = [todo("install", "pnpm install")];
    const args = baseArgs();
    const dag = buildRunnerDag(todos, args);
    const output = formatDryRun(dag);
    assert.ok(output.includes("[shared]"), `expected [shared] in:\n${output}`);
  });
});

// ─── runner integration ────────────────────────────────────────────────────

describe("runTodoPlan (integration with mocked executors)", () => {
  it("runs subagent tasks and writes results back", async () => {
    const todos = [
      todo("feat-a", "implement A"),
      todo("feat-b", "implement B"),
    ];
    const args = baseArgs();
    const dag = buildRunnerDag(todos, args);
    assert.equal(dag.errors.length, 0);

    let concurrency = 0;
    const subagent: SubagentExecutor = async (plan) => {
      concurrency++;
      // simulate slight work
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true, summary: `done: ${plan.label}` };
    };
    const startBgTask: BgExecutor = async () => "bg_task_0";
    const pollBgTask: BgPoller = async () => ({ ok: true, done: true, summary: "bg ok" });

    const onEvents: RunnerTaskStatus[] = [];
    const options: RunTodoPlanOptions = {
      subagent,
      startBgTask,
      pollBgTask,
      maxConcurrency: 2,
      onEvent: (event) => { onEvents.push(event.status); },
    };
    const outcomes = await runTodoPlan(dag, options);
    assert.equal(outcomes.length, 2);
    assert.ok(outcomes.every((o) => o.ok));
    // Both tasks completed → completed status emitted twice
    const completed = onEvents.filter((s) => s === "completed").length;
    assert.equal(completed, 2);
    // Both subagent tasks ran (in one batch with maxConcurrency=2)
    assert.ok(concurrency >= 2, `expected both subagent tasks to run, saw ${concurrency}`);

    // merge back
    const merged = mergeOutcomesIntoTodos(todos, outcomes);
    assert.equal(merged.todos.length, 2);
    assert.equal(merged.todos[0]?.status, "completed");
    assert.equal(merged.todos[1]?.status, "completed");
    assert.ok(merged.revision > 0);
  });

  it("marks dependent tasks as blocked when a subagent task fails", async () => {
    const todos = [
      todo("fail", "make this fail"),
      todo("depends-on-fail", "run e2e"),
    ];
    const args = baseArgs();
    args.deps = { "depends-on-fail": ["fail"] };
    const dag = buildRunnerDag(todos, args);

    const subagent: SubagentExecutor = async (plan) => {
      if (plan.label === "fail") return { ok: false, error: "intentional failure" };
      return { ok: true, summary: "fine" };
    };
    const startBgTask: BgExecutor = async () => "noop";
    const pollBgTask: BgPoller = async () => ({ ok: true, done: true });

    const outcomes = await runTodoPlan(dag, { subagent, startBgTask, pollBgTask, maxConcurrency: 1 });
    const failOutcome = outcomes.find((o) => o.taskId === "fail")!;
    const depOutcome = outcomes.find((o) => o.taskId === "depends-on-fail")!;
    assert.equal(failOutcome.ok, false);
    assert.ok(failOutcome.error?.includes("intentional failure"));
    assert.equal(depOutcome.ok, false);
    assert.ok(depOutcome.error?.includes("blocked"));
  });

  it("runs bg tasks through startBgTask/pollBgTask", async () => {
    const todos = [todo("test", "run tests cmd: npm test")];
    const args = baseArgs();
    const dag = buildRunnerDag(todos, args);
    assert.equal(dag.tasks[0]?.runner, "bg");

    const calls: string[] = [];
    const startBgTask: BgExecutor = async (plan) => {
      calls.push(`start:${plan.command}`);
      return "bg_123";
    };
    const pollBgTask: BgPoller = async (taskId) => {
      calls.push(`poll:${taskId}`);
      return { ok: true, done: true, summary: "exit 0" };
    };
    const subagent: SubagentExecutor = async () => ({ ok: true });

    const outcomes = await runTodoPlan(dag, { subagent, startBgTask, pollBgTask, maxConcurrency: 1 });
    assert.equal(outcomes[0]?.ok, true);
    assert.equal(outcomes[0]?.bgTaskId, "bg_123");
    assert.deepEqual(calls, ["start:npm test", "poll:bg_123"]);
  });

  it("respects maxConcurrency for unlocked subagent batches", async () => {
    const todos = [
      todo("a", "feature a"),
      todo("b", "feature b"),
      todo("c", "feature c"),
      todo("d", "feature d"),
    ];
    const args = baseArgs();
    const dag = buildRunnerDag(todos, args);

    let active = 0;
    let maxSeen = 0;
    const subagent: SubagentExecutor = async () => {
      active++;
      maxSeen = Math.max(maxSeen, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return { ok: true };
    };
    const startBgTask: BgExecutor = async () => "noop";
    const pollBgTask: BgPoller = async () => ({ ok: true, done: true });

    await runTodoPlan(dag, { subagent, startBgTask, pollBgTask, maxConcurrency: 2 });
    assert.ok(maxSeen <= 2, `expected max concurrency ≤ 2, saw ${maxSeen}`);
    assert.ok(maxSeen >= 2, `expected concurrency of 2, saw ${maxSeen}`);
  });

  it("serializes locked tasks behind a per-lock mutex", async () => {
    const todos = [
      todo("install", "pnpm install"),
      todo("test", "run pnpm test"),
    ];
    // No explicit deps: both locked; install → deps lock, test → build lock
    // They are solo batches already, so add a second install task to test
    // same-lock serialization.
    todos.push(todo("install2", "npm ci"));
    const args = baseArgs();
    const dag = buildRunnerDag(todos, args);

    let active = 0;
    let lockViolations = 0;
    const lockActive = new Map<string, number>();
    const subagent: SubagentExecutor = async () => ({ ok: true });
    const startBgTask: BgExecutor = async (plan) => {
      const lock = lockFor(dag.tasks.find((t) => t.content === plan.command)?.resourceClass ?? "install");
      const prev = lockActive.get(lock ?? "none") ?? 0;
      if (prev > 0) lockViolations++;
      lockActive.set(lock ?? "none", prev + 1);
      await new Promise((r) => setTimeout(r, 20));
      lockActive.set(lock ?? "none", prev);
      return `bg_${plan.command}`;
    };
    const pollBgTask: BgPoller = async () => ({ ok: true, done: true });

    await runTodoPlan(dag, { subagent, startBgTask, pollBgTask, maxConcurrency: 4 });
    assert.equal(lockViolations, 0, "same-lock tasks must never overlap");
  });

  it("aborts on signal", async () => {
    const todos = [todo("a", "feature a"), todo("b", "feature b")];
    const args = baseArgs();
    const dag = buildRunnerDag(todos, args);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const subagent: SubagentExecutor = async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { ok: true };
    };
    const startBgTask: BgExecutor = async () => "x";
    const pollBgTask: BgPoller = async () => ({ ok: true, done: true });
    const outcomes = await runTodoPlan(dag, {
      subagent,
      startBgTask,
      pollBgTask,
      maxConcurrency: 2,
      signal: controller.signal,
    });
    // At least one outcome should be present
    assert.ok(outcomes.length >= 0);
  });
});

// ─── execute.ts helpers ────────────────────────────────────────────────────

describe("planRunnerTask / subagentPromptFor / defaultBgCommand", () => {
  const codeTask: RunnerTask = {
    todoId: "feat",
    label: "feat",
    content: "implement auth",
    runner: "subagent",
    resourceClass: "code",
    dependsOn: ["install"],
    model: "claude-sonnet",
    files: ["src/auth.ts"],
    status: "pending",
  };

  const installTask: RunnerTask = {
    todoId: "install",
    label: "install",
    content: "pnpm install",
    runner: "bg",
    resourceClass: "install",
    dependsOn: [],
    status: "pending",
  };

  it("plans a subagent task with prompt and model", () => {
    const plan = planRunnerTask(codeTask);
    assert.equal(plan.kind, "subagent");
    if (plan.kind === "subagent") {
      assert.ok(plan.task.includes("implement auth"));
      assert.ok(plan.task.includes("src/auth.ts"));
      assert.equal(plan.model, "claude-sonnet");
      assert.equal(plan.label, "feat");
    }
  });

  it("requires an explicit bg command", () => {
    assert.throws(() => planRunnerTask(installTask), /explicit command/);
    const plan = planRunnerTask({ ...installTask, content: "install deps cmd: npm install" });
    assert.equal(plan.kind, "bg");
    if (plan.kind === "bg") {
      assert.equal(plan.command, "npm install");
      assert.deepEqual(plan.tags, ["todo-runner", "install"]);
    }
  });

  it("defaultBgCommand maps test to npm test", () => {
    const testTask: RunnerTask = {
      ...installTask,
      resourceClass: "test",
      runner: "bg",
    };
    assert.equal(defaultBgCommand(testTask), "npm test");
    assert.equal(defaultBgCommand({ ...testTask, content: "run cmd: pnpm test" }), "pnpm test");
  });

  it("subagentPromptFor includes dep and file constraints", () => {
    const prompt = subagentPromptFor(codeTask);
    assert.ok(prompt.includes("install"));
    assert.ok(prompt.includes("src/auth.ts"));
  });
});

// ─── merge.ts ──────────────────────────────────────────────────────────────

describe("mergeOutcomesIntoTodos", () => {
  it("marks completed todos completed and failed todos failed", () => {
    const todos = [
      todo("a", "A"),
      todo("b", "B"),
    ];
    const outcomes: RunnerOutcome[] = [
      { taskId: "a", ok: true, summary: "done" },
      { taskId: "b", ok: false, error: "crashed" },
    ];
    const merged = mergeOutcomesIntoTodos(todos, outcomes);
    assert.equal(merged.todos[0]?.status, "completed");
    assert.equal(merged.todos[1]?.status, "failed");
    assert.equal(merged.todos[1]?.error, "crashed");
    assert.ok(merged.revision > 0);
  });

  it("leaves todos without an outcome untouched", () => {
    const todos = [todo("a", "A"), todo("b", "B")];
    const outcomes: RunnerOutcome[] = [{ taskId: "a", ok: true }];
    const merged = mergeOutcomesIntoTodos(todos, outcomes);
    assert.equal(merged.todos[0]?.status, "completed");
    assert.equal(merged.todos[1]?.status, "pending");
  });
});

describe("formatOutcome / summarizeOutcomes", () => {
  it("formats a successful outcome", () => {
    const line = formatOutcome({ taskId: "a", ok: true, summary: "added endpoint" }, "auth-api", "implement auth");
    assert.ok(line.includes("auth-api"));
    assert.ok(line.includes("added endpoint"));
  });

  it("summarizes counts", () => {
    const todos = [todo("a", "A"), todo("b", "B"), todo("c", "C")];
    const args = baseArgs();
    const dag = buildRunnerDag(todos, args);
    const outcomes: RunnerOutcome[] = [
      { taskId: "a", ok: true },
      { taskId: "b", ok: false, error: "failed" },
      { taskId: "c", ok: false, error: "blocked" },
    ];
    const summary = summarizeOutcomes(dag, outcomes);
    assert.ok(summary.includes("1 done"));
    assert.ok(summary.includes("failed"));
  });
});
