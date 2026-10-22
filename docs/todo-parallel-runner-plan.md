# Todo Parallel Runner — Implementation Plan

> Status: **Plan only** (no code changes yet). The working tree currently has unrelated
> changes; this plan is written against the code as of 2026-10-21.
>
> Companion docs: `docs/multi-agent-orchestration-design.md` (DAG dispatch §4.5, file
> conflicts §4.7, acceptance gates §6, rollback §7), `docs/subagent-next-gen-upgrade.md`.

---

## 1. Goals & Non-Goals

### Goals
1. Explicit, user-triggered parallel execution of the current Todo list via
   `/todos run --parallel`. Nothing runs on todo mutation — no auto-backgrounding.
2. Build a DAG from the current `todoItems` **plus** explicit user input
   (`--only`, `--deps`, `--model`, `--files`), then dispatch ready batches with
   the existing `subagent_batch` machinery (`dependsOn` + `maxConcurrency`).
3. Classify work so shared resources are never contended:
   - `code` work → isolated subagent (worktree via `git_branch_isolate` /
     `GitWorkflow.createIsolatedBranch`, or plain subagent when no git repo).
   - `install` / `dependency` / `lockfile` / `migration` work → `bg_start`
     background task, **serially gated** behind a per-workspace resource lock.
4. Persistence & resume: a runner job survives process restart like
   `subagent/async-batch.ts` jobs do (`~/.mini-agent/subagent-jobs/` style), and
   `/todos run --resume` or `/todos run` (with a resumable job present) picks it up.
5. Write results back into the Todo list (`SET_TODO_ITEMS` with revisions), so the
   TodoPanel and task summary reflect each item's real outcome, with failure
   propagation (`blocked` downstream, `failed` upstream) exactly like
   `multi-agent-orchestration-design.md` §4.5/§7.
6. `--dry-run` renders the full dispatch plan (batches, resource locks, predicted
   concurrency, conflicts, per-task runner choice) without starting anything.

### Non-Goals
- No automatic backgrounding when the model rewrites todos (explicit command only).
- No new queue/worker process (路线 B from the orchestration doc). We reuse
  in-process `subagent_batch` + `bg_start`; cross-machine dispatch is out of scope.
- No changes to `TodoWrite` tool semantics; the model keeps replacing the list,
  the runner just *executes* items.
- No new model/agent profile system; we reuse `SubagentProfile` and
  `roleLlmConfigs` (light/standard/flagship mapping) as-is.
- No new TUI panel framework; we extend `BgTaskLivePanel` rendering and add a
  compact runner status row/section inside the existing panel.

---

## 2. User Stories

```text
# List is: 1) add deps (completed), 2) implement auth api, 3) add tests, 4) run e2e
/todos run --parallel
> Parsed 4 todos → DAG: [install-deps] → {auth-api ∥ auth-tests} → e2e
> Plan:
>   batch 0 (serial, resource-lock): bg_start "npm ci"            [install]
>   batch 1 (concurrent, worktree):  auth-api (coder, wt-1), auth-tests (coder, wt-2)
>   batch 2 (serial, resource-lock): bg_start "pnpm test:all"     [test]
> Start? [y/N]

/todos run --parallel --dry-run
> (prints the plan above with predicted wall-time, lock waits, and conflict
>  warnings; exits without dispatch)

# select subset, override model for one item, and resume later
/todos run --parallel --only auth-api,e2e --model e2e=flagship
/todos run --resume        # after crash: re-dispatches pending items, re-waits running bg tasks
```

Failure story: `auth-api` subagent fails → `auth-tests` (which depends on it) is
marked `blocked` in the Todo list with `error: "dependency auth-api failed"`,
e2e stays `pending`, the summary panel shows `2 done · 1 failed · 1 blocked`,
and the user can `/todos run --retry` to re-dispatch only the failed/blocked tail.

---

## 3. Architecture

### 3.1 Module layout (new)

```
src/todos/                          # new module
├── index.ts                        # public API re-exports
├── parser.ts                       # /todos run flag parsing (CLI grammar, validation)
├── dag.ts                          # DAG build/validation/topological batches
├── classify.ts                     # resource classification + lock assignment
├── isolate.ts                      # worktree isolation per code task (git or noop)
├── runner.ts                       # job state machine, scheduler, persistence
├── execute.ts                      # subagent / bg_start executors + result capture
├── merge.ts                        # per-task merge, acceptance gate, todo write-back
├── dry-run.ts                      # plan renderer for --dry-run
└── types.ts                        # RunnerJob, RunnerTask, RunnerEvent, schemas

src/tui/
├── todos-run-commands.ts           # new: command handlers (parallel/resume/retry/status)
└── components/
    └── BgTaskLivePanel.tsx         # extended: "runner" section + inline todo badges

src/tui/slash-commands.ts           # +2 catalog entries, +parser cases
src/tui/tui-core/command-runners.ts # +local handlers so headless path also works
```

Everything below is pure TS with **no React in `src/todos/`** — the TUI layer
adapts events to ink lines (mirrors how `BgTaskLivePanel` consumes a manager).

### 3.2 Command registration

`/todos` already exists in `SLASH_COMMANDS` (`{ name: "tasks", usage: TODO_COMMAND_USAGE }`,
plus the `todo` alias). Extend `TODO_COMMAND_USAGE` to:
`"/tasks [show|hide|compact|expanded|clear] | /todos run [--parallel] [--dry-run] [--only …] [--deps …] [--retry] [--resume] [--max-concurrency N] [--model label=ref] [--files label=paths]"`.

Changes in `src/tui/slash-commands.ts`:
- Add to `SlashCommand` union:
  ```ts
  | { cmd: "todos-run"; args: ParsedTodosRunArgs }
  ```
- Extend `parseSlashCommand`: new case `"tasks"`/`"todo"` already routes to
  `parseLegacyTodoCommand`; when the remainder is `run`, call the new
  `parseTodosRunCommand(remainder)` from `src/todos/parser.ts` and return
  `{ cmd: "todos-run", args }`. Unknown flags → return `null` (falls through to
  agent with a "did you mean /help" notice via the existing
  `unknownSlashCommand` guard).
- `src/tui/tui-core/command-runners.ts`: register a `run` body for `cmd: "todos-run"`
  that calls the shared handler `runTodosParallel(ctx, args)` (renderer-agnostic,
  uses `ctx.store` + notices), returning `true` (local handling, no agent turn).
- `src/tui/App.tsx`: handle `trimmed.startsWith("/todos run")` /
  `trimmed.startsWith("/tasks run")` in the submit pipeline and route to the same
  handler; on interactive confirmation, use the existing pending-permission bar
  pattern (`PermissionPanel`) rather than raw `y/N` prompt so it is cancellable
  with Esc.

`ParsedTodosRunArgs` (in `src/todos/types.ts`):

```ts
export type ParsedTodosRunArgs = {
  parallel: boolean;          // --parallel (the mode being planned; always true for this command)
  dryRun: boolean;           // --dry-run
  resume: boolean;          // --resume: attach to an existing resumable job
  retry: boolean;          // --retry: re-dispatch failed/blocked tail of current job
  only?: string[];         // --only label1,label2 (todo ids or 1-based indices)
  deps?: string[];        // --deps "a<-b" (add explicit edge a before b)
  model?: Record<string, string>;   // --model label=ref
  files?: Record<string, string[]>;  // --files label=path1,path2
  maxConcurrency?: number;          // --max-concurrency N (0 = unlimited, default)
};
```

Parser validation (fail fast, all reported in one notice):
- `--only` values resolve against current `todoItems` (id or index); unknown → error listing valid ids.
- `--deps` edges: `a<-b` means **b depends on a**; both must exist; self-edge or edge
  creating a cycle → error with the involved labels.
- `--model` refs resolve against the model catalog (`commitModelSetup`'s catalog),
  else error listing known refs.
- `--files` paths exist relative to cwd, else error.
- `--max-concurrency` is `>= 1` (or 0 = unlimited).

### 3.3 DAG construction

Sources, in priority order:
1. **Current todos** (`store.getState().todoItems`, falling back to
   `executionPlanToTodoItems(state.currentPlan)` when only a plan exists — same
   resolution as `resolveTodoItems` in `src/tui/todo-format.ts`).
2. **`--deps` edges** added on top.
3. **Implicit edges** from classification: an `install` task precedes every
   `code` task that touches source (dependency ordering); `test` tasks that the
   user added follow the code tasks they exercise (only when an explicit
   `--deps` or `files` overlap links them — we do **not** invent semantic edges
   for code tasks; without `--deps`, code tasks are siblings in one batch).

```ts
// src/todos/dag.ts
export type RunnerNode = {
  id: string;               // todo id (todo-<sha12>) — stable across rewrites when content unchanged
  content: string;
  activeForm: string;
  todoStatus: TodoStatus;
  files: string[];          // from --files or inference (below)
  dependsOn: string[];      // ids
  classification: ResourceClass;
  runner: "subagent" | "bg_start";
  model?: string;
  worktree: boolean;
};
export type RunnerGraph = {
  nodes: RunnerNode[];
  batches: string[][];     // topological batches; batch i only runs after batch i-1 accepted
  conflicts: FileConflict[];
  cycles: string[];        // non-empty ⇒ refuse to start
};
export function buildRunnerGraph(
  todos: readonly TodoItem[],
  user: ParsedTodosRunArgs,
  classify: (content: string, files: string[]) => ResourceClass,
): RunnerGraph;
```

`buildRunnerGraph` reuses `validateAsyncDag`'s algorithm (label uniqueness,
unknown-dependency, self-dependency, cycle detection — exported from
`src/subagent/async-batch.ts` so the runner and subagent_batch share one
implementation) and adds:
- **File-conflict pass** (orchestration doc §4.7): compute
  `transitiveFiles(node) = files ∪ testFileHints(content) ∪ sharedConfigFiles`
  (shared config = lockfiles, `tsconfig.json`, `package.json`, CI workflows).
  Any pair in the same batch with intersecting transitive files is a
  `FileConflict { nodeA, nodeB, files: string[] }`; the resolver either
  (a) if a conflict involves a shared-config file, re-serializes the two nodes
  into consecutive solo batches, or (b) if `worktree` isolation is enabled
  (`--worktree`, default on in git repos) and conflicts are limited to
  non-shared files, keeps them in the same batch with `worktree: true` on both
  (disjoint worktrees → disjoint filesystems → no conflict). `--no-worktree`
  falls back to (a) for all conflicts.
- **Batch cap**: when a batch would exceed `maxConcurrency` (or the default of
  `min(4, cpuCount)` when 0/unlimited is requested), split it — resource-lock
  tasks are always solo batches (see §3.4).

Test-file inference (`testFileHints`, conservative): a todo whose content
mentions `test|spec|vitest|jest|playwright|pytest|go test` and names a module
`foo` gets hints `[foo.test.*, foo.spec.*, test/*foo*]`. No inference ⇒ no
files ⇒ treated as a shared-config owner (forces solo batch when in a
conflicting batch). This is deliberately pessimistic: it's cheap and shows up in
`--dry-run` so the user can correct it with `--files`.

### 3.4 Resource classification & locks

```ts
// src/todos/classify.ts
export type ResourceClass =
  | "code"        // writes source only; parallelizable in worktrees
  | "install"     // npm/pnpm/yarn/bun dependency management, lockfile edits
  | "test"        // test/build pipeline (pnpm test, vitest, pnpm build, tsc)
  | "migration"   // DB migrations, lockfile/schema migration
  | "docs"        // pure docs (parallelizable like code, no worktree needed)
  | "unknown";

export const WORKSPACE_MUTATION_LOCKS = ["deps", "build", "db"] as const;
export type WorkspaceMutationLock = (typeof WORKSPACE_MUTATION_LOCKS)[number];

export function classifyTodo(content: string, files: string[]): ResourceClass;
export function lockFor(classification: ResourceClass): WorkspaceMutationLock | null;
// install → "deps"; test/build → "build"; migration → "db"; others → null
export function lockGroupsFor(graph: RunnerGraph): Array<{
  lock: WorkspaceMutationLock;
  soloBatchIndex: number; // batch position the lock occupies (serialized there)
}>;
```

Rules (matching the user requirement that installs/lockfiles/migrations never
run concurrently with other workspace mutations):
- Every node with a non-null `lock` is placed in its **own batch**; batches
  sharing the same lock are forced to consecutive positions in topological
  order, never interleaved with each other or with other locked tasks.
- The runtime enforces this with a **per-lock `AsyncLock`** (a tiny
  promise-chained mutex, ~20 lines, no dependency) held across the entire
  execution of that task's `bg_start` + `bg_wait`.
- `bg_wait` blocks **inside the runner scheduler** (not as an LLM tool call),
  so the lock is held for the full lifetime of the background command, and
  queued locked tasks wait on the lock — not on wall time.

Decision table — **subagent vs bg_start**:

| Classification | Runner | Why |
|---|---|---|
| `code`, `docs`, `unknown` | `subagent` (batch task, `profile: "coder"`) | reasoning-heavy; structured result; can be retried cheaply; per-task worktree isolation |
| `install` | `bg_start` (e.g. `pnpm install --frozen-lockfile`, command from `classifyTodo` + user `--cmd` override) | long, command-shaped, deterministic; log stream into BgTaskLivePanel |
| `test` | `bg_start` (e.g. `pnpm test` / `pnpm vitest run`) | long; produces a pass/fail signal we can read from the log tail |
| `migration` | `bg_start` | must be serial and visible; db lock |

The executor mapping in `execute.ts` takes a `TaskRunnerSpec`:

```ts
export type TaskRunnerSpec =
  | { kind: "subagent"; label: string; task: string; profile?: string; model?: string;
      maxTurns?: number; sharedContext?: string; dependsOn?: string[];
      worktreePath?: string;       // set when isolated
      tokenBudget?: number }
  | { kind: "bg"; command: string; name: string; cwd?: string;
      timeoutSeconds?: number; tags: string[] };
export function specFor(node: RunnerNode, graph: RunnerGraph): TaskRunnerSpec;
```

### 3.5 Isolation

`src/todos/isolate.ts` wraps `GitWorkflow.createIsolatedBranch`:

```ts
export type IsolationMode = "worktree" | "shared" | "none";
export async function prepareIsolation(
  graph: RunnerGraph,
  mode: IsolationMode,           // default: worktree when in a git repo, shared otherwise
  git: GitWorkflow,
): Promise<Map<string /*nodeId*/, { worktreePath: string; branch: string } | undefined>>;
```

- `worktree` (default when `git.status().dirty || git.status().clean` and repo
  exists): one worktree **per concurrent code task** (`mini-agent/todo-<id>`
  branches, under the existing `worktreeDir`). Shared-config conflicts are
  still forced solo (§3.3) because worktrees don't isolate lockfiles that are
  written by install tasks (install tasks run in the main workspace under the
  lock; worktree tasks read the main workspace's lockfile state at start).
- `shared`: all tasks run in the main workspace; the conflict resolver (§3.3a)
  applies to **all** file overlaps, not just shared configs.
- `none`: no worktree; used when there is no git repo (plain directory) —
  then the user is warned that overlapping-file tasks will be serialized.

Merge-back after a subagent task: run inside the worktree
(`git -C <wt> add -A && git commit -m "todo:<id>"`), then in main workspace
`git merge --no-ff <branch>`; on conflict → mark task `failed` with
`error: "merge conflict; branch preserved at mini-agent/todo-<id>"` and **do
not auto-resolve** (mirrors orchestration doc §5.7: branch stays for manual
review). For `shared` mode, skip the worktree commit; gate runs against the main
workspace instead.

### 3.6 Runner job & persistence

State machine for a job (mirrors `async-batch.ts` TaskState plus a
resource-lock layer):

```
pending → running → {done, failed, blocked}
                        └─(retry)→ running
```

```ts
// src/todos/types.ts
export type RunnerTaskState = "pending" | "running" | "done" | "failed" | "blocked" | "skipped";
export type RunnerJob = {
  id: string;                 // "trj_<uuid>"
  createdAt: string;
  mode: IsolationMode;
  graph: RunnerGraph;
  maxConcurrency: number;
  tasks: Record<string, { state: RunnerTaskState; runner: "subagent" | "bg";
                          runnerRef: string; // subagent batch task id OR bg taskId
                          worktree?: string; branch?: string;
                          startedAt?: string; endedAt?: string;
                          error?: string;   // for failed/blocked
                          changedFiles?: string[];
                        }>;
  completedBatches: number;
};
export type RunnerEvent =
  | { type: "job_started"; jobId: string }
  | { type: "batch_started"; jobId: string; batchIndex: number }
  | { type: "task_started"; jobId: string; taskId: string; runner: "subagent" | "bg"; ref: string }
  | { type: "task_finished"; jobId: string; taskId: string; ok: boolean; error?: string;
       changedFiles?: string[]; summary?: string }
  | { type: "batch_finished"; jobId: string; batchIndex: number }
  | { type: "job_finished"; jobId: string; result: { done: number; failed: number; blocked: number } }
  | { type: "lock_acquired" | "lock_released"; jobId: string; lock: WorkspaceMutationLock };
```

Persistence: **the same `~/.mini-agent/` data dir** as subagent jobs, at
`~/.mini-agent/todo-runner-jobs/<jobId>.json`, written atomically (temp +
rename, mode 0o600) on every task transition — directly following
`async-batch.persist()` (see `writeQueues` dedup there). On startup
(`--resume` or plain `/todos run` when a resumable job exists):
- load jobs, re-attach `bg` refs via `BgTaskManager` (bg tasks persist in
  `.bg-tasks/` store; `bg_status` tells us if the ref is still alive,
  completed, or lost → lost ⇒ re-dispatch that task).
- subagent refs: if the process died mid-batch, the subagent job's
  `resumeAsyncBatches` handles re-execution of its own pending tasks; the
  runner re-submits the same `execute` callback, so no separate resume
  machinery is needed — we just re-call
  `submitAsyncBatch(remainingSubagentTasks, execute, maxConcurrency)` for the
  unfinished subagent portion of the batch.

Resume eligibility rule: a job is resumable iff `state ∈ {pending, running}`
for at least one task and **no resource lock is currently held** (a lock can
only be held in-process; on crash the lock is automatically free, and install
tasks are idempotent under `--frozen-lockfile`).

### 3.7 Acceptance & write-back

Per task (orchestration doc §6.1 gate pipeline, adapted for the in-process case):

1. **Status gate** — subagent: `success && !partial` from `subagent_end`;
   bg: `exitCode === 0` from `bg_wait`.
2. **Scope gate** — `changedFiles ⊆ transitiveFiles(node) ∪ declaredExtraFiles`
   (extra files must be named in the subagent's result `notes` field; we ask
   for a structured JSON result block: the subagent system-prompt addition
   requires `{"status":"done|blocked|failed","changed_files":[...],"summary":"...","notes":"..."}`
   as the final answer — see `execute.ts` where we build the task prompt).
3. **Gate command** (only for `test`/`install`/`migration` classes, and only
   in shared mode; in worktree mode the gate already ran inside the worktree):
   run the class's gate command (`pnpm test -- --run` etc. — the same command
   we bg-started). Fail ⇒ task `failed`, batch halts, downstream
   `blocked`.
4. **Write-back** — on `done`: dispatch
   `SET_TODO_ITEMS` with that item `status: "completed"` (revision via
   `nextTodoRevision()` — see `src/todo.ts:13`); on `failed`:
   `status: "failed"` + `error`; on upstream failure: `status: "failed"` stays,
   downstream get `status: "pending"` + `error: "blocked: <depId> failed"`
   (the TodoItem type has `error?: string` — `src/todo.ts:43`).

The TUI's `TodoPanel`/`TaskSummaryPanel` pick this up automatically because
they read `state.todoItems` (already the case — `SET_TODO_ITEMS` reducer at
`src/tui/state.ts:194`).

### 3.8 Sequence diagram — happy path

```mermaid
sequenceDiagram
  autonumber
  participant U as User (/todos run --parallel)
  participant P as Parser (todos/parser.ts)
  participant D as DAG builder (todos/dag.ts)
  participant C as Classifier (todos/classify.ts)
  participant I as Isolation (todos/isolate.ts)
  participant R as Runner (todos/runner.ts)
  participant S as subagent_batch (subagent/tool.ts)
  participant B as BgTaskManager (bg-tasks/manager.ts)
  participant T as Todos write-back (tui/state.ts)

  U->>P: /todos run --parallel [--only… --deps… --model…]
  P->>P: parse + validate flags (§3.2)
  P->>D: current todoItems + flags
  D->>C: classify each node (content+files)
  C-->>D: ResourceClass + lock
  D->>D: topo batches + conflict pass (§3.3/3.4)
  D-->>P: RunnerGraph
  P->>U: --dry-run? → print plan, stop (§3.2)
  U->>P: confirm (PermissionPanel)
  P->>I: prepareIsolation(graph, mode)
  I-->>P: worktree map (or shared)
  P->>R: startJob(job)
  loop each batch (topo order)
    R->>R: acquire locks for this batch's locked tasks (AsyncLock)
    par subagent tasks in batch
      R->>S: submitAsyncBatch(tasks, execute, maxConcurrency)
      S-->>R: results (JSON final answer)
    and bg tasks (one at a time, in lock)
      R->>B: start({command, tags:[todo:<id>]}) → taskId
      R->>B: wait([taskId], "all")
      B-->>R: exitCode
    end
    R->>T: SET_TODO_ITEMS (revisions, statuses, errors)
    R->>R: release locks; record batch_finished
  end
  R-->>U: job_finished summary (done/failed/blocked + per-task detail)
```

### 3.9 Sequence diagram — failure + resume

```mermaid
sequenceDiagram
  autonumber
  participant R as Runner
  participant B as BgTaskManager
  participant T as Todos
  participant U as User

  Note over R: batch k: auth-api subagent fails
  R->>R: mark auth-api failed (scope gate fail)
  R->>R: mark auth-tests blocked (dep)
  R->>T: SET_TODO_ITEMS {auth-api:failed, auth-tests:pending+error, …}
  R-->>U: job summary with blocked/failed tail

  Note over U: user fixes, then:
  U->>R: /todos run --retry
  R->>R: load job; pending/failed/blocked tasks only
  R->>B: re-attach bg refs (bg_status) → lost? re-dispatch
  R->>R: re-run remaining batches (lock-free start OK after crash)
```

---

## 4. Concrete File/Module Changes

| File | Change |
|---|---|
| `src/todos/types.ts` (new) | `RunnerNode`, `RunnerGraph`, `RunnerJob`, `RunnerTaskState`, `RunnerEvent`, `TaskRunnerSpec`, `ParsedTodosRunArgs`, `FileConflict`, JSON schemas for the subagent result block (§3.7.2) |
| `src/todos/parser.ts` (new) | `parseTodosRunCommand(input: string): ParsedTodosRunArgs \| { error: string }`; flag validation per §3.2 |
| `src/todos/dag.ts` (new) | `buildRunnerGraph(todos, user, classify): RunnerGraph`; `testFileHints(content): string[]`; reuses `validateAsyncDag` (add export in `src/subagent/async-batch.ts:69` — it's already `export`) |
| `src/todos/classify.ts` (new) | `classifyTodo`, `lockFor`, `gateCommandFor(classification, pkgManager) → string \| null`; pkgManager sniffed from lockfile presence (`package-lock.json` → npm, `pnpm-lock.yaml` → pnpm, …) |
| `src/todos/isolate.ts` (new) | `prepareIsolation` (§3.5); uses `GitWorkflow.createIsolatedBranch` (`src/git/workflow.ts:224`); `mergeWorktreeBack(worktree, mainCwd) → { ok, conflict?: string[] }` |
| `src/todos/runner.ts` (new) | `class TodoRunner { constructor(deps: RunnerDeps); startJob(graph, opts): Promise<RunnerJob>; resumeJob(id): Promise<RunnerJob>; retryJob(id): Promise<RunnerJob>; on(event, cb) }`; `RunnerDeps = { subagent: SubagentBatchToolApi; bg: BgTaskManager; git: GitWorkflow \| null; store: TuiStore; }`; AsyncLock impl (`acquire(lock): Promise<release>`); persistence per §3.6 |
| `src/todos/execute.ts` (new) | `executeSubagentTask(task, ctx): Promise<ToolResult>` (wraps `submitAsyncBatch` single-task call; builds the prompt with result-JSON contract); `executeBgTask(task, ctx): Promise<{ ok: boolean; changedFiles?: string[]; summary?: string }>` (bg_start + bg_wait + log-tail summary extraction: last 32KB of `bg_logs` → regex for pass/fail lines) |
| `src/todos/merge.ts` (new) | `mergeTaskResult(task, result, mode): { ok: boolean; error?: string; changedFiles?: string[] }` (the 4 gates, §3.7); `writeBackTodos(store, task, result)` → `dispatch SET_TODO_ITEMS` with `nextTodoRevision()` |
| `src/todos/dry-run.ts` (new) | `renderDryRunPlan(graph, classify, opts): string[]` (line-array, TUI-independent; `App.tsx` joins with `\n` for the notice; also feeds `/todos run --parallel --dry-run` headless output) |
| `src/tui/todos-run-commands.ts` (new) | `handleTodosRun(ctx: CommandContext, args: ParsedTodosRunArgs): Promise<boolean>`; wires parser → graph → runner; dispatches `ADD_NOTICE` for plan/summary; stores `RunnerJob` in `ctx.store` via a new `RUNNER_JOB_*` action |
| `src/tui/state.ts` | add actions `{ type: "SET_RUNNER_JOB"; job: RunnerJob \| undefined }`, `{ type: "SET_TODO_ITEMS"; … }` already exists (line 194) — extend `TuiState` with `runnerJob?: RunnerJob` |
| `src/tui/slash-commands.ts` | add `todos-run` to `SlashCommand`; extend `parseSlashCommand` case for `tasks`/`todo` + `run`; extend `TODO_COMMAND_USAGE` (§3.2) |
| `src/tui/tui-core/command-runners.ts` | add `case "todos-run":` local runner (calls `handleTodosRun`, returns `true`) |
| `src/tui/App.tsx` | wire `trimmed.startsWith("/todos run")` branch to `handleTodosRun`; on `runnerJob` state, render runner summary into the existing notice area; pass `runnerJob` to `BgTaskLivePanel` |
| `src/tui/components/BgTaskLivePanel.tsx` | extend `BgTaskLivePanelProps` with `runnerJob?: RunnerJob`; add a "Runner" section above the bg-task list showing per-task state (✓/✗/…/⏸) and, for `bg` tasks, inline log tail (reuse existing `logOffsetRef` mechanism); filter `bg_status` list by `tags` containing `todo:<id>` when a runner job is active |
| `src/subagent/async-batch.ts` | no change needed — `validateAsyncDag`, `submitAsyncBatch`, `resumeAsyncBatches` are reused as-is (add a small `re-submit` helper only if runner needs to resume a *partial* batch: `resumeJobTasks(job, tasks, execute, limit)` — a thin wrapper calling `submitAsyncBatch` with the remaining task subset; ~15 lines) |

### JSON schema — subagent task result block (used in §3.7.2 prompt)

```jsonc
{
  "type": "object",
  "required": ["status", "changed_files", "summary"],
  "additionalProperties": false,
  "properties": {
    "status":   { "enum": ["done", "blocked", "failed"] },
    "message":  { "type": "string" },
    "changed_files": { "type": "array", "items": { "type": "string" } },
    "summary":  { "type": "string" },
    "test_result": { "type": "string" },
    "notes":    { "type": "string" }
  }
}
```

---

## 5. Edge Cases, Test Plan, Acceptance Criteria, Rollout

### Edge cases (each gets a unit test in `test/todos-runner.test.ts`)

| # | Case | Expected |
|---|---|---|
| E1 | Empty todo list, `--parallel` | Notice "No todos to run." No job. |
| E2 | Only `completed` todos, `--parallel` | Notice "All todos completed; nothing to run." |
| E3 | `--deps` with a cycle (`a<-b, b<-a`) | Parser error listing the cycle; no dispatch. |
| E4 | `--only` with a bad id | Parser error listing valid ids. |
| E5 | Two code todos both edit `package.json` (shared config), `--no-worktree` | Conflicted pair moved to consecutive solo batches. |
| E6 | Same pair, default worktree mode | Both run in parallel in disjoint worktrees; solo-batching not required (conflict pass detects disjoint worktrees → no solo needed). |
| E7 | `install` task + `code` task in same topological batch | `install` is solo; `code` tasks wait for `install` to complete (DAG edge: install → code, added implicitly by `classifyTodo`). |
| E8 | Subagent fails scope gate (changed a file not in `transitiveFiles`) | Task `failed`; error = "out-of-scope file: X"; branch preserved (worktree mode). |
| E9 | BG task (`pnpm install`) times out | `bg_wait` returns timeout; task `failed` with `error: "timeout after Ns"`; lock released. |
| E10 | Process killed mid-batch; `--resume` | BG refs re-attached via `bg_status`; lost refs re-dispatched; subagent pending tasks re-submitted; completed tasks not re-run. |
| E11 | `--retry` after a failed task | Only failed/blocked tasks re-enter the scheduler; completed tasks are not re-dispatched. |
| E12 | No git repo, `worktree` default | `isolate.ts` detects no repo → falls back to `shared` mode with warning; conflict resolver solo-batches all file overlaps. |
| E13 | `maxConcurrency: 1` | All code tasks in a batch run sequentially (subagent_batch `limit=1`); bg tasks unaffected (already solo). |
| E14 | Todo content mentions `test` but no file path | `testFileHints` produces glob; treated as a file hint in conflict pass; user can correct with `--files`. |
| E15 | Two `install` tasks in the DAG | Both solo, consecutive batches (lock "deps" serializes them even across batches — `AsyncLock` is process-wide). |

### Test plan

- **Unit** (`test/todos-runner.test.ts`): parser cases E1–E4, E11; `buildRunnerGraph` cases E3, E5, E6, E7, E12, E13 (pure function, mock `classify`); `lockFor` exhaustiveness; gate logic in `mergeTaskResult` with mock results.
- **Integration** (`test/todos-runner.it.test.ts`, run in CI with a fixture git repo):
  - subagent mock: inject a fake `subagent_batch` executor (the runner's `RunnerDeps.subagent` seam) that returns a canned `ToolResult`; verify batch ordering, lock serialization, todo write-back revisions, and `SET_TODO_ITEMS` contents.
  - bg mock: fake `BgTaskManager` (in-memory) returning exit codes; verify install-then-code ordering and `failed → blocked` propagation.
  - Resume: kill the runner mid-batch (simulate by not calling `resumeJobTasks` on completed tasks), then call `resumeJob` and verify completed tasks are skipped.
- **TUI** (`test/todos-runner.tui.test.ts`, `ink-testing-library`):
  - `BgTaskLivePanel` renders a runner section from a sample `RunnerJob` (3 tasks: done/failed/blocked).
  - `/todos run --parallel --dry-run` produces the plan notice; `/todos run --parallel` without confirmation does **not** start the job.
- **No new deps**: only existing `node:*` + ink + the repo's own modules.

### Acceptance criteria (feature is "done" when all hold)

1. `/todos run --parallel` on a 5-item todo list (mix of code+install+test) completes with the correct topological order and lock serialization; todo statuses are written back with `SET_TODO_ITEMS` + revisions.
2. `--dry-run` output matches the actual execution order (verified by recording a real run's batch plan and diffing against a `--dry-run` run on the same list).
3. `--resume` after a forced crash (kill the node process mid-batch, restart, `/todos run --resume`) re-dispatches only incomplete tasks and re-attaches live bg tasks; completed tasks are not re-run (asserted in the integration test via subagent-call counter).
4. Two `install`-classified tasks never overlap in time (asserted by the `AsyncLock` acquisition log in test E15).
5. A scope-gate failure (E8) results in the worktree branch being preserved (branch exists in `git branch` list after the test) and the todo showing `failed` with the error string.
6. No change to `TodoWrite` tool behavior, `subagent_batch` tool behavior, or `bg_start` tool behavior when the runner is not invoked (regression: run the existing `test/subagent.test.ts`, `test/bg-tasks.e2e.test.ts`, `test/todo*` suites and confirm green).

### Phased rollout

| Phase | Scope | Exit criteria |
|---|---|---|
| P0 (1–2 days) | `types.ts`, `parser.ts`, `dag.ts` (no execution), `dry-run.ts`, slash-command + TUI notice wiring, E1–E4 unit tests | `/todos run --parallel --dry-run` prints a correct plan for a hand-crafted todo list; `--dry-run` never mutates state. |
| P1 (2–3 days) | `classify.ts`, `isolate.ts`, `runner.ts` + `execute.ts` + `merge.ts`, shared-mode execution (no worktree), persistence, E5–E9, E11–E14 tests, `SET_TODO_ITEMS` write-back, `BgTaskLivePanel` runner section | A 3-task DAG (install → code → test) runs end-to-end in shared mode on a fixture repo; crash+`--resume` works for the bg path only. |
| P2 (2 days) | Worktree isolation (`isolate.ts` merge path), E6/E12/E13 tests, `--model` per-task override, cost budget passthrough (`globalTokenBudget` → `submitAsyncBatch`) | Worktree mode: parallel code tasks in a real git repo merge cleanly; conflict case leaves branch + `failed` status. |
| P3 (1 day) | Full regression (`subagent`, `bg-tasks`, `todo*` suites), acceptance criteria 1–6 verified in a recording test, docs/README update (`docs/todo-parallel-runner-plan.md` → "implemented" status + usage section moved to README) | All 6 acceptance criteria pass; existing test suite green. |

---

## 6. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `validateAsyncDag` semantics differ from runner's needs (e.g., runner wants implicit install→code edges not in the user's DAG) | Medium | Wrong batch order | Build the full edge set **before** calling `validateAsyncDag`; the implicit edges are added by `buildRunnerGraph`, not by the validator, so the validator only sees the final graph. Test E7 asserts this. |
| Worktree merge conflicts silently break the main workspace | Low | Dirty main tree | Merge is `--no-ff` with `--no-commit`; on conflict, the merge is rolled back (`git merge --abort`) before marking the task `failed`; branch is preserved. No auto-resolve (§3.5). |
| BG task log summary extraction (regex for pass/fail) is fragile | Medium | Wrong `done`/`failed` status | The gate (exit code from `bg_wait`) is authoritative; the regex summary is **informational only** (displayed in the notice, never used for status). |
| `AsyncLock` held across a crash appears stuck on resume | Low | Resume deadlocks | Locks are process-local by design; on crash the process is gone and the lock is gone; `--resume` starts with all locks free. Asserted in test E10/E15. |
| Subagent result-JSON contract not honored by a weak model | Medium | Scope-gate false failure | Parse failure → fall back to "scope gate: cannot determine scope; task done but needs review" (`status: done`, `changedFiles: []`, `notes: "scope review required"`); the runner marks it `done` but adds a visible `⚠ review` badge in the panel. Never marks it `failed` for a parse failure. |
| Token budget exhausted mid-batch | Medium | Partial batch, all remaining `blocked` | `submitAsyncBatch` already handles this (`budget_warning` event); runner maps `budget` error kind to `failed` + `error: "token budget exhausted"` and marks remaining tasks `blocked` (consistent with §4.5 failure propagation). |
| `install` lock blocks a legitimate parallel install of a *different* package set | Low | Slower execution than expected | Documented: the lock is per-workspace (one package manager, one lockfile). If a user truly wants two concurrent installs, that is a `--no-lock` escape hatch (explicit opt-in, off by default, not in P0–P2). |
| `--deps` syntax is awkward | Low | Poor UX | P3: accept `/todos run --parallel` + a natural-language prompt that the model rewrites into a corrected `--deps` set before dispatching (the model sees the graph in the dry-run notice and can propose corrections inline). |
| Existing working-tree changes get mixed into worktrees | Medium | Unexpected commits | `createIsolatedBranch` (`src/git/workflow.ts:224`) already refuses to create a worktree from a dirty tree ("Create an isolated branch only from a clean worktree; create a checkpoint first") — the runner respects this: when the main tree is dirty, it suggests `/plan` checkpoint or `git_branch_isolate` manually first, then proceeds in `shared` mode. |

---

*Plan written 2026-10-22. Companion docs referenced:
`docs/multi-agent-orchestration-design.md` §4.3/§4.5/§4.7/§6/§7,
`docs/subagent-next-gen-upgrade.md`.*
