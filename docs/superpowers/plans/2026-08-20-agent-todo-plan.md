# Agent Todo TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Claude Code-like, agent-managed todo checklist above the Ink TUI input prompt.

**Architecture:** Add a validated `todo_write` local tool that sends complete todo snapshots to a TUI reducer callback. Store todos independently from plans and tool steps, render them through a compact `TodoPanel`, and subtract its bounded row count from the message viewport height.

**Tech Stack:** TypeScript, React 18, Ink, Node test runner via `tsx --test`, TypeScript compiler.

---

## File Map

- Create `src/tools/todo.ts`: todo item types, snapshot validation, and the
  callback-backed `todo_write` tool.
- Modify `src/tools/index.ts`: export the tool and register `todo_write` as a
  selectable tool name.
- Create `src/tui/components/TodoPanel.tsx`: compact read-only checklist and
  row-count helper used by layout calculations.
- Modify `src/tui/state.ts`: store todo snapshots, replace them through a
  reducer action, reset them, and suppress raw `todo_write` tool cards.
- Modify `src/tui/layout.ts`: subtract todo panel rows from the message feed.
- Modify `src/tui/App.tsx`: add the local todo tool to the TUI agent provider,
  render the panel above the prompt, and pass its row count to layout.
- Create `test/todo.test.ts`: validation and tool callback behavior.
- Create `test/tui-todo.test.ts`: reducer, panel formatting, and layout behavior.
- Modify `test/tui-state.test.ts` only if a focused regression belongs beside
  existing reducer lifecycle tests.

## Task 1: Add the Todo Tool Contract

**Files:**
- Create: `src/tools/todo.ts`
- Modify: `src/tools/index.ts`
- Test: `test/todo.test.ts`

- [ ] **Step 1: Write failing validation and tool tests**

Add tests for the actual exported API:

```ts
const valid = [
  { id: "read", content: "Read the config", status: "completed" },
  { id: "test", content: "Run tests", status: "in_progress", activeForm: "Running tests" },
  { id: "review", content: "Review the result", status: "pending" },
] as const;

it("accepts a valid snapshot and invokes the callback once", async () => {
  const updates: TodoItem[][] = [];
  const tool = createTodoTool((todos) => updates.push(todos));
  const result = await tool.execute({ todos: valid });

  assert.equal(result.isError, undefined);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], valid);
  assert.match(contentAsString(result.content), /pending=1/);
});

it("rejects duplicate ids, blank content, and multiple active items", async () => {
  const tool = createTodoTool(() => { throw new Error("callback must not run"); });
  const result = await tool.execute({
    todos: [
      { id: "same", content: "One", status: "in_progress" },
      { id: "same", content: "Two", status: "in_progress" },
    ],
  });

  assert.equal(result.isError, true);
  assert.match(contentAsString(result.content), /unique|in_progress/i);
});

it("allows an empty snapshot to clear the list", async () => {
  const updates: TodoItem[][] = [];
  const result = await createTodoTool((todos) => updates.push(todos)).execute({ todos: [] });
  assert.equal(result.isError, undefined);
  assert.deepEqual(updates, [[]]);
});
```

Use the repository's `node:assert/strict` and `node:test` style, and add a
small `contentAsString` helper in the test if needed for `MessageContent`.

- [ ] **Step 2: Run the focused test and verify the expected red failure**

Run:

```text
pnpm exec tsx --test test/todo.test.ts
```

Expected: FAIL because `src/tools/todo.ts` and its exports do not exist yet.

- [ ] **Step 3: Implement the minimal validated tool**

Implement these stable exports:

```ts
export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoItem = {
  id: string;
  content: string;
  status: TodoStatus;
  activeForm?: string;
};
export type TodoWriteArgs = { todos: TodoItem[] };
export function validateTodoSnapshot(value: unknown): TodoItem[];
export function createTodoTool(onUpdate: (todos: TodoItem[]) => void): Tool<TodoWriteArgs>;
```

`validateTodoSnapshot` must reject non-arrays, invalid statuses, blank ids or
content, duplicate ids, non-string `activeForm`, more than one
`in_progress` item, and more than 50 items. It must return a new normalized
array with trimmed `id`, `content`, and `activeForm` values. `createTodoTool`
must call `onUpdate` only after validation, return counts in a success string,
and return `{ content: errorMessage, isError: true }` for validation failures.
Use tool annotations `{ readOnlyHint: true, idempotentHint: true }` and a
description that tells the agent to send the full list, keep at most one item
in progress, and update completion as work changes.

Export `createTodoTool`, `TodoItem`, `TodoStatus`, and `TodoWriteArgs` from
`src/tools/index.ts`, and add `"todo_write"` to `ToolName`.

- [ ] **Step 4: Run the focused tests and typecheck the changed module**

Run:

```text
pnpm exec tsx --test test/todo.test.ts
pnpm exec tsc --noEmit
```

Expected: all todo tests pass and typecheck exits with code 0.

## Task 2: Add TUI State and Rendering

**Files:**
- Create: `src/tui/components/TodoPanel.tsx`
- Modify: `src/tui/state.ts`
- Test: `test/tui-todo.test.ts`

- [ ] **Step 1: Write failing reducer and formatting tests**

Cover replacement, reset, status symbols, active-form text, truncation, and
overflow. The reducer assertions should use real `createInitialState` and
`tuiReducer`:

```ts
it("replaces the independent todo snapshot", () => {
  const todos = [{ id: "a", content: "Run tests", status: "in_progress" as const }];
  const next = tuiReducer(createInitialState("model"), { type: "SET_TODOS", todos });
  assert.deepEqual(next.todos, todos);
});

it("clears todos on reset while preserving global display settings", () => {
  const state = {
    ...createInitialState("model"),
    todos: [{ id: "a", content: "Done", status: "completed" as const }],
  };
  const next = tuiReducer(state, { type: "RESET" });
  assert.deepEqual(next.todos, []);
  assert.equal(next.permissionMode, state.permissionMode);
});
```

Add pure formatter assertions for `formatTodoPanel` or the equivalent
exported helper: `✓`, `▶`, and `○` appear for the three statuses; an active
form replaces content only for the active item; six visible rows are retained;
and an overflow line reports the remaining count.

- [ ] **Step 2: Run the focused TUI todo test and verify it fails for the feature reason**

Run:

```text
pnpm exec tsx --test test/tui-todo.test.ts
```

Expected: FAIL because `TuiState.todos`, `SET_TODOS`, and `TodoPanel` exports
do not exist yet.

- [ ] **Step 3: Implement state and compact rendering**

Import `TodoItem` from `src/tools/todo.ts`, add `todos: TodoItem[]` to
`TuiState`, initialize it to `[]`, add `{ type: "SET_TODOS"; todos: TodoItem[] }`
to `TuiAction`, and replace the list in the reducer. `RESET` must use the
initial empty list while preserving thinking and permission modes as it does
today.

In `TodoPanel.tsx`, export:

```ts
export const MAX_VISIBLE_TODOS = 6;
export function getTodoPanelRows(todos: TodoItem[]): number;
export function formatTodoPanel(todos: TodoItem[]): string[];
export function TodoPanel(props: { todos: TodoItem[]; width: number }): React.ReactElement | null;
```

Return zero rows and `null` for an empty list. Otherwise produce one header,
up to six one-line rows, and one `… N more` line when needed. Use `wrap="truncate-end"`
and the existing colors from `src/tui/theme.ts`; the component must remain
read-only and have no keyboard handler.

In the reducer's `tool_start` and `tool_end` branches, special-case
`event.call.name === "todo_write"` so its raw call does not append a
`tool_call` message, `ToolCardState`, or `WorkflowStep`. Preserve all other
tool behavior unchanged. Its visible state is supplied by `SET_TODOS` from the
tool callback.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```text
pnpm exec tsx --test test/tui-todo.test.ts test/tui-state.test.ts
pnpm exec tsc --noEmit
```

Expected: all focused reducer/formatter tests pass and no existing reducer
tests regress.

## Task 3: Integrate the Tool, Panel, and Viewport Layout

**Files:**
- Modify: `src/tui/App.tsx`
- Modify: `src/tui/layout.ts`
- Test: `test/tui-todo.test.ts`

- [ ] **Step 1: Write failing layout and tool-provider integration tests**

Add a layout assertion that a todo panel consumes its row count:

```ts
const base = getMessageFeedHeight({ termRows: 24 });
const withTodos = getMessageFeedHeight({ termRows: 24, todoRows: 4 });
assert.equal(base - withTodos, 4);
```

Also add a tool-provider-level test using `createTodoTool` and an update
callback to prove a valid tool call reaches the TUI state boundary; no React
mount or network model is required.

- [ ] **Step 2: Run the focused test and verify the new assertions fail**

Run:

```text
pnpm exec tsx --test test/tui-todo.test.ts
```

Expected: FAIL because `getMessageFeedHeight` does not accept `todoRows` and
the App provider does not yet include `todo_write`.

- [ ] **Step 3: Integrate the callback-backed tool and panel**

In `App.tsx`, create one stable tool after `useReducer`:

```ts
const todoToolRef = useRef<Tool>();
if (!todoToolRef.current) {
  todoToolRef.current = createTodoTool((todos) => dispatch({ type: "SET_TODOS", todos }));
}
```

When building the per-turn tool list, append the tool unless the supplied
provider already contains a `todo_write` tool. This keeps injected test or
embedding providers from receiving duplicates while ensuring normal TUI turns
always expose the feature.

Pass `todoRows: getTodoPanelRows(state.todos)` to `getMessageFeedHeight`, and
render `<TodoPanel todos={state.todos} width={termWidth} />` in the fixed
bottom chrome immediately before pending images and the prompt row.

In `layout.ts`, add the optional `todoRows` value to the chrome sum without
changing the existing minimum feed height or picker behavior.

- [ ] **Step 4: Run focused integration tests and typecheck**

Run:

```text
pnpm exec tsx --test test/tui-todo.test.ts test/tui-input.test.ts test/tui-render.test.ts
pnpm exec tsc --noEmit
```

Expected: all listed tests pass, including the viewport constraints.

## Task 4: Full Verification and Review

**Files:**
- Review: all files changed by Tasks 1-3

- [ ] **Step 1: Inspect the diff and check for unrelated changes**

Run:

```text
git -c safe.directory='C:/项目/mini-agent-loop' diff --check
git -c safe.directory='C:/项目/mini-agent-loop' status --short
```

Confirm the diff contains only the todo implementation, its tests, and the
implementation plan; preserve all pre-existing user changes.

- [ ] **Step 2: Run the complete test suite and build check**

Run:

```text
pnpm test
pnpm run typecheck
```

Expected: both commands exit 0 with no failed tests or TypeScript errors.

- [ ] **Step 3: Manually inspect the final behavior contract**

Verify against the design acceptance criteria: the agent tool replaces the
full list, invalid snapshots leave the old list intact, the panel is above the
prompt, completed rows remain visible, `/clear` removes todos, and bounded
rows preserve Ink's terminal-height safety.
