# Agent Todo Persistence, Editing, and Web Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the agent Todo snapshot with server sessions, support safe TUI editing, and expose a real-time editable Web Todo view.

**Architecture:** Keep `TodoItem[]` as the canonical complete snapshot. Server sessions own `todos` and `todoVersion`, `SessionStore` writes both into existing JSONL snapshots, and a per-session SSE subscriber set broadcasts successful updates. TUI remains an independent local session and uses pure command/editor helpers plus the existing reducer. A small static Web page calls the Todo REST API and subscribes to the session SSE stream.

**Tech Stack:** TypeScript/Node.js, Express 5, existing JSONL `SessionStore`, Ink/React TUI, vanilla browser JavaScript, Node test runner, Supertest, and `tsx`.

---

## File Map

- Modify `src/tools/todo.ts`: allow async update callbacks and distinguish validation errors from persistence errors.
- Modify `src/session-store.ts`: serialize and restore optional Todo fields while remaining compatible with old JSONL events.
- Modify `src/server.ts`: add session Todo state, the session-bound Agent tool, REST/SSE endpoints, static Web serving, and fork/session payload support.
- Create `src/tui/todo-commands.ts`: pure `/todo` parser and complete-snapshot mutations.
- Create `src/tui/todo-editor.ts`: pure keyboard editor state transitions.
- Create `src/tui/components/TodoEditor.tsx`: Ink editor overlay.
- Modify `src/tui/slash-commands.ts`: register `/todo` parsing and path-independent command metadata.
- Modify `src/tui/components/FileAutocomplete.tsx`: show `/todo` in the command palette.
- Modify `src/tui/hooks/useKeyboardHandler.ts`: add `Ctrl+Shift+T` handling and editor key routing without breaking existing shortcuts.
- Modify `src/tui/components/Overlays.tsx`: render the Todo editor overlay.
- Modify `src/tui/App.tsx`: execute `/todo` without an Agent turn, manage editor state, and suspend the main prompt while editing.
- Create `web/index.html`: maintainable Web shell.
- Create `web/app.js`: session selection, REST loading, SSE subscription, and Todo mutations.
- Create `web/styles.css`: dense responsive Todo layout.
- Modify `test/todo.test.ts`: async callbacks and persistence error behavior.
- Modify `test/session-store.test.ts`: Todo/version round trips and legacy compatibility.
- Modify `test/server.test.ts`: Todo API, session restore, Agent tool persistence, and static page tests.
- Create `test/server-todo-sse.test.ts`: live SSE initial/update/cleanup behavior.
- Create `test/tui-todo-commands.test.ts`: parser and mutation behavior.
- Modify `test/tui-todo.test.ts`: editor/reducer integration behavior.
- Modify `test/tui-autocomplete.test.ts`: `/todo` command palette coverage if the mode type changes.

## Task 1: Make Todo Updates Async-Safe

**Files:**
- Modify: `src/tools/todo.ts`
- Test: `test/todo.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests that prove the update callback can be asynchronous and that callback failures are not reported as validation failures:

```ts
it("awaits an asynchronous update callback", async () => {
  let saved = false;
  const tool = createTodoTool(async () => {
    await Promise.resolve();
    saved = true;
  });

  const result = await tool.execute({
    todos: [{ id: "one", content: "Save", status: "pending" }],
  });

  assert.equal(saved, true);
  assert.equal(result.isError, undefined);
});

it("reports persistence failures without calling them invalid snapshots", async () => {
  const result = await createTodoTool(async () => {
    throw new Error("disk unavailable");
  }).execute({
    todos: [{ id: "one", content: "Save", status: "pending" }],
  });

  assert.equal(result.isError, true);
  assert.match(String(result.content), /Todo update failed: disk unavailable/);
  assert.doesNotMatch(String(result.content), /Invalid todo snapshot/);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```text
pnpm exec tsx --test test/todo.test.ts
```

Expected: the asynchronous callback test completes before `saved` is set, and the persistence error test reports the current `Invalid todo snapshot` wording.

- [ ] **Step 3: Write minimal implementation**

Change the callback type to `void | Promise<void>`, validate before invoking it, await it, and use separate messages:

```ts
export function createTodoTool(
  onUpdate: (todos: TodoItem[]) => void | Promise<void>,
): Tool {
  return {
    // Preserve the existing metadata and schema.
    name: "todo_write",
    execute: async (args) => {
      let todos: TodoItem[];
      try {
        todos = validateTodoSnapshot(args?.todos);
      } catch (error) {
        return {
          content: `Invalid todo snapshot: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
      try {
        await onUpdate(todos);
      } catch (error) {
        return {
          content: `Todo update failed: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
      const counts = todos.reduce(
        (result, todo) => ({ ...result, [todo.status]: result[todo.status] + 1 }),
        { pending: 0, in_progress: 0, completed: 0 },
      );
      return {
        content: `Todo list updated: pending=${counts.pending}, in_progress=${counts.in_progress}, completed=${counts.completed}`,
      };
    },
  };
}
```

Keep the existing summary text and schema unchanged. The validation catch must return `Invalid todo snapshot: ...`; the callback catch must return `Todo update failed: ...` with `isError: true`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run `pnpm exec tsx --test test/todo.test.ts`. Expected: all Todo tool tests pass.

- [ ] **Step 5: Commit**

```text
git add src/tools/todo.ts test/todo.test.ts
git commit -m "feat: await todo update callbacks"
```

## Task 2: Persist Todo State in Session JSONL

**Files:**
- Modify: `src/session-store.ts`
- Test: `test/session-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a round-trip test with a completed item plus version `4`, and a legacy session test that creates a session without Todo fields and asserts `todos` is `[]` and `todoVersion` is `0` after load:

```ts
it("round-trips session todos and their version", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-todos-"));
  try {
    const store = new SessionStore(root);
    await store.create({
      id: "todo-session",
      createdAt: Date.now(),
      todos: [{ id: "build", content: "Build", status: "completed" }],
      todoVersion: 4,
      messages: [],
    });

    const restored = await new SessionStore(root).loadAll();
    assert.deepEqual(restored.get("todo-session")?.todos, [
      { id: "build", content: "Build", status: "completed" },
    ]);
    assert.equal(restored.get("todo-session")?.todoVersion, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("defaults missing Todo fields for legacy sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-legacy-"));
  try {
    const store = new SessionStore(root);
    await store.create({ id: "legacy", createdAt: Date.now(), messages: [] });
    const restored = await store.loadAll();
    assert.deepEqual(restored.get("legacy")?.todos, []);
    assert.equal(restored.get("legacy")?.todoVersion, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run `pnpm exec tsx --test test/session-store.test.ts`. Expected: TypeScript rejects the new fields and the loaded legacy values are undefined.

- [ ] **Step 3: Implement JSONL compatibility**

Import `TodoItem`, add optional `todos?: TodoItem[]` and `todoVersion?: number` to the persisted boundary so existing fixtures and old callers remain valid. Add optional fields to both event types, write them in `create` and `save`, and restore with:

```ts
todos: Array.isArray(parsed.todos) ? parsed.todos as TodoItem[] : (current?.todos ?? []),
todoVersion: typeof parsed.todoVersion === "number"
  ? parsed.todoVersion
  : (current?.todoVersion ?? 0),
```

For `session_created`, default to `[]` and `0`. Keep malformed JSONL line handling unchanged.

- [ ] **Step 4: Run the focused test and verify it passes**

Run `pnpm exec tsx --test test/session-store.test.ts`. Expected: all session-store tests pass.

- [ ] **Step 5: Commit**

```text
git add src/session-store.ts test/session-store.test.ts
git commit -m "feat: persist todo snapshots with sessions"
```

## Task 3: Add Server-Owned Session Todo State and Agent Binding

**Files:**
- Modify: `src/server.ts`
- Test: `test/server.test.ts`

- [ ] **Step 1: Write failing server tests**

Add tests that create a server with a fake `chat` function that returns a `todo_write` tool call on the first request and a final assistant response on the second. Assert the message stream contains the tool result, `GET /api/sessions/:id` exposes the snapshot, and a second server instance with the same `dataDir` restores it. Also assert forked sessions inherit the current snapshot:

```ts
const todos = [{ id: "inspect", content: "Inspect code", status: "in_progress" as const }];
let turns = 0;
const app = createAgentServer({
  llm,
  tools: [],
  chat: async () => {
    turns++;
    return turns === 1
      ? {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "todo-1", name: "todo_write", arguments: { todos } }],
        }
      : { role: "assistant", content: "done" };
  }, 
});
const created = await request(app).post("/api/sessions");
const sessionId = (created.body as { id: string }).id;
const response = await request(app)
  .post(`/api/sessions/${sessionId}/messages`)
  .field("prompt", "track this task");
assert.equal(response.status, 200);
const detail = await request(app).get(`/api/sessions/${sessionId}`);
assert.deepEqual((detail.body as { todos: unknown[] }).todos, todos);
assert.equal((detail.body as { todoVersion: number }).todoVersion, 1);
```

The test must also assert a caller-supplied `tools: []` still gets the session-bound `todo_write` tool, because Todo is a session feature rather than an optional workspace tool.

- [ ] **Step 2: Run the focused test and verify it fails**

Run `pnpm exec tsx --test test/server.test.ts`. Expected: the tool call is not available and session details do not contain Todo fields.

- [ ] **Step 3: Add the session fields and shared update function**

Import `createTodoTool`, `validateTodoSnapshot`, and `TodoItem`. Add required runtime fields to `Session`:

```ts
todos: TodoItem[];
todoVersion: number;
```

Add `todos` and `todoVersion` to `persistedSession`, restore them with `persisted.todos ?? []` and `persisted.todoVersion ?? 0`, and initialize new sessions. Add a local subscriber map:

```ts
const todoSubscribers = new Map<string, Set<Response>>();
```

Implement `updateSessionTodos(session, nextTodos, source)` with a per-session promise chain so concurrent Agent/Web updates serialize their version check, JSONL append, and broadcast. Validate and clone first; retain the previous snapshot/version; assign the new snapshot and increment the version; if `saveSession` rejects, restore the previous values and rethrow. Only broadcast after persistence succeeds. Add a `createSessionTodoTool(session)` factory whose async callback calls this updater with source `agent`.

- [ ] **Step 4: Bind the tool in every server Agent path**

For the normal message path and plan execution path, build the existing `baseToolProvider` as:

```ts
const baseToolProvider: ToolProvider = () => [
  ...resolveToolProvider(tools),
  documentTool,
  createSessionTodoTool(session),
];
```

Keep the existing subagent factory around that provider so nested agents see the same session Todo tool. Do not add a second tool card to the normal server event stream; the existing sanitized `tool_start`/`tool_end` behavior remains unchanged.

- [ ] **Step 5: Add session payload fields and fork behavior**

Add `todos` and `todoVersion` to `GET /api/sessions/:id`. When constructing a fork, copy `parent.todos` and `parent.todoVersion` so the fork starts from the same complete snapshot.

- [ ] **Step 6: Run the focused tests and verify they pass**

Run `pnpm exec tsx --test test/server.test.ts test/session-store.test.ts test/todo.test.ts`. Expected: all selected tests pass.

- [ ] **Step 7: Commit**

```text
git add src/server.ts test/server.test.ts
git commit -m "feat: bind todo updates to agent sessions"
```

## Task 4: Add Todo REST and SSE APIs

**Files:**
- Modify: `src/server.ts`
- Modify: `test/server.test.ts`
- Create: `test/server-todo-sse.test.ts`

- [ ] **Step 1: Write failing REST tests**

Cover the initial empty response, valid replacement, normalization, invalid snapshot (`400`), stale version (`409` with current `todos` and `version`), and unknown session (`404`):

```ts
const initial = await request(app).get(`/api/sessions/${id}/todos`);
assert.deepEqual(initial.body, { todos: [], version: 0 });

const updated = await request(app)
  .put(`/api/sessions/${id}/todos`)
  .send({ todos: [{ id: "one", content: "Work", status: "pending" }], version: 0 });
assert.deepEqual(updated.body, {
  todos: [{ id: "one", content: "Work", status: "pending" }],
  version: 1,
});

const conflict = await request(app)
  .put(`/api/sessions/${id}/todos`)
  .send({ todos: [], version: 0 });
assert.equal(conflict.status, 409);
assert.equal(conflict.body.version, 1);
```

- [ ] **Step 2: Run the focused REST tests and verify they fail**

Run `pnpm exec tsx --test test/server.test.ts`. Expected: the Todo routes return `404` because they do not exist.

- [ ] **Step 3: Implement the REST routes**

Add `GET /api/sessions/:id/todos` and `PUT /api/sessions/:id/todos` before the generic session detail route. The PUT handler must call `validateTodoSnapshot` before checking or changing state, compare `request.body.version` only when it is a number, call `updateSessionTodos(session, todos, "web")`, and map errors to `400` or `409` without mutating the session on failure.

- [ ] **Step 4: Write the failing SSE test**

Use an ephemeral `http.Server` around `createAgentServer`, read the response body with a native `fetch`, and assert the first `data:` frame contains version `0`. Perform a REST update and assert the same stream receives `event: todo_updated` with source `web`. Call `reader.cancel()`, await the server-side response close, make a second update, and assert the request still returns `200`; this proves a disconnected browser is removed without affecting later updates.

- [ ] **Step 5: Run the SSE test and verify it fails**

Run `pnpm exec tsx --test test/server-todo-sse.test.ts`. Expected: the endpoint returns `404` or no event frame.

- [ ] **Step 6: Implement the SSE route and cleanup**

On connection, set `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, and `Connection: keep-alive`; flush headers, register the response, send the current snapshot immediately, and remove it on `response.close`. Use a small `writeTodoEvent(response, payload)` function that checks `writableEnded` before writing:

```ts
response.write(`event: todo_updated\\ndata: ${JSON.stringify(payload)}\\n\\n`);
```

Keep the source and version in every update payload. Broadcast failures remove only the failed response.

- [ ] **Step 7: Run server Todo tests**

Run `pnpm exec tsx --test test/server.test.ts test/server-todo-sse.test.ts`. Expected: REST and SSE tests pass.

- [ ] **Step 8: Commit**

```text
git add src/server.ts test/server.test.ts test/server-todo-sse.test.ts
git commit -m "feat: expose real-time todo session APIs"
```

## Task 5: Add Pure TUI Todo Commands

**Files:**
- Create: `src/tui/todo-commands.ts`
- Modify: `src/tui/slash-commands.ts`
- Modify: `src/tui/components/FileAutocomplete.tsx`
- Test: `test/tui-todo-commands.test.ts`

- [ ] **Step 1: Write failing parser and mutation tests**

Cover list, add, start, pending, done, edit, delete, clear, stable ID generation, and rejection without mutation:

```ts
assert.deepEqual(parseTodoCommand("/todo add Write tests"), {
  action: "add", content: "Write tests",
});
assert.deepEqual(parseTodoCommand("/todo done build"), {
  action: "status", id: "build", status: "completed",
});

const initial = [{ id: "a", content: "A", status: "in_progress" as const }];
const started = applyTodoCommand([...initial, { id: "b", content: "B", status: "pending" }], {
  action: "status", id: "b", status: "in_progress",
});
assert.deepEqual(started.todos, [
  { id: "a", content: "A", status: "pending" },
  { id: "b", content: "B", status: "in_progress" },
]);
assert.equal(applyTodoCommand(initial, { action: "delete", id: "missing" }).ok, false);
assert.deepEqual(initial, [{ id: "a", content: "A", status: "in_progress" }]);
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run `pnpm exec tsx --test test/tui-todo-commands.test.ts`. Expected: module/functions are missing.

- [ ] **Step 3: Implement the pure command module**

Define `TodoCommand`, `TodoCommandResult`, `parseTodoCommand(input)`, and `applyTodoCommand(todos, command)`. Parse exactly the commands in the design spec. For add, choose the smallest unused `todo-N` ID. For any transition to `in_progress`, set all other items to `pending`. Return `{ ok: false, error, todos }` on invalid input and preserve the input snapshot by value.

Extend `parseSlashCommand` to return a Todo command payload or route `/todo` parsing through `parseTodoCommand`, add `/todo` to `SLASH_COMMANDS`, and keep it out of `PATH_COMMANDS`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run `pnpm exec tsx --test test/tui-todo-commands.test.ts test/tui-autocomplete.test.ts`. Expected: command parsing and existing autocomplete behavior pass.

- [ ] **Step 5: Commit**

```text
git add src/tui/todo-commands.ts src/tui/slash-commands.ts src/tui/components/FileAutocomplete.tsx test/tui-todo-commands.test.ts test/tui-autocomplete.test.ts
git commit -m "feat: add manual todo slash commands"
```

## Task 6: Add TUI Todo Editor State and Overlay

**Files:**
- Create: `src/tui/todo-editor.ts`
- Create: `src/tui/components/TodoEditor.tsx`
- Modify: `src/tui/hooks/useKeyboardHandler.ts`
- Modify: `src/tui/components/Overlays.tsx`
- Modify: `src/tui/App.tsx`
- Test: `test/tui-todo.test.ts`
- Test: `test/tui-autocomplete.test.ts`

- [ ] **Step 1: Write failing editor state tests**

Add pure tests for opening at the first item, arrow selection, status cycling, delete, add/edit draft confirmation, Escape cancellation, and empty-list add mode:

```ts
let editor = createTodoEditorState([
  { id: "one", content: "One", status: "pending" },
  { id: "two", content: "Two", status: "completed" },
]);
editor = reduceTodoEditor(editor, { type: "MOVE", delta: 1 });
assert.equal(editor.selectedIndex, 1);
editor = reduceTodoEditor(editor, { type: "CYCLE_STATUS" });
assert.equal(editor.todos[1]?.status, "pending");
editor = reduceTodoEditor(editor, { type: "BEGIN_EDIT" });
assert.equal(editor.mode, "edit");
assert.equal(editor.draft, "Two");
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run `pnpm exec tsx --test test/tui-todo.test.ts`. Expected: editor module/functions are missing.

- [ ] **Step 3: Implement the pure editor state machine**

Define `TodoEditorMode = "select" | "add" | "edit"`, state fields `todos`, `selectedIndex`, `mode`, `draft`, and `editingId`, plus `createTodoEditorState` and `reduceTodoEditor`. Reuse the command mutation helpers for status/delete/add/edit and clamp selection after deletions. Return the original snapshot when Escape cancels.

- [ ] **Step 4: Implement the Ink overlay**

Create `TodoEditor` that renders the selectable list, status symbols, current selection, and a focused `PromptInput` only in add/edit mode. Expose callbacks for `onCommit(todos)`, `onCancel()`, and `onStateChange`. Keep the editor within the existing overlay area so it does not change the fixed Todo panel height.

- [ ] **Step 5: Wire keyboard routing without shortcut regressions**

Add `Ctrl+Shift+T` before the existing Ctrl+T thinking shortcut. Change the existing Ctrl+T branch to require `!key.shift`. While the editor is open, route arrows, `a`, `e`, `s`, `d`, Enter, and Escape to the editor; leave ordinary printable draft text to the editor `PromptInput`. Main `PromptInput` receives `focus={false}` while editing. Existing permission handling and autocomplete handling remain higher priority. No change to `src/tui/input-utils.ts` is required because this editor is an independent overlay, not an autocomplete mode.

- [ ] **Step 6: Wire `/todo` into App without an Agent turn**

Handle `parseTodoCommand(trimmed)` before the busy-message queue branch so manual changes are immediate. Dispatch `SET_TODOS` only for `result.ok`, emit an `ADD_NOTICE` for success/error, clear the input, and dispatch no `USER_MESSAGE`. Render `TodoEditor` through `Overlays` while open.

- [ ] **Step 7: Run TUI tests and typecheck**

Run:

```text
pnpm exec tsx --test test/tui-todo.test.ts test/tui-todo-commands.test.ts test/tui-autocomplete.test.ts
pnpm run typecheck
```

Expected: all selected tests and the typecheck pass.

- [ ] **Step 8: Commit**

```text
git add src/tui/todo-editor.ts src/tui/components/TodoEditor.tsx src/tui/hooks/useKeyboardHandler.ts src/tui/components/Overlays.tsx src/tui/App.tsx test/tui-todo.test.ts test/tui-autocomplete.test.ts
git commit -m "feat: edit todos from the TUI"
```

## Task 7: Add the Web Todo Page and Static Serving

**Files:**
- Create: `web/index.html`
- Create: `web/app.js`
- Create: `web/styles.css`
- Modify: `src/server.ts`
- Modify: `test/server.test.ts`

- [ ] **Step 1: Write the failing static-page test**

Add a test that requests `/`, `/app.js`, and `/styles.css` and asserts successful content types and stable markers:

```ts
const page = await request(app).get("/");
assert.equal(page.status, 200);
assert.match(page.text, /agent-todo-app/);
assert.match((await request(app).get("/app.js")).text, /EventSource/);
assert.match((await request(app).get("/styles.css")).text, /todo-list/);
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run `pnpm exec tsx --test test/server.test.ts`. Expected: `/` and the new assets return the existing JSON `404` response.

- [ ] **Step 3: Add maintainable static assets**

Create an accessible page with a session select, connection status, completion summary, Todo list, add form, status selector, edit/delete controls, and clear control. The core browser flow must have this shape:

```js
let state = { sessionId: "", todos: [], version: 0, stream: null };

function applySnapshot(payload) {
  state.todos = Array.isArray(payload.todos) ? payload.todos : [];
  state.version = Number.isInteger(payload.version) ? payload.version : 0;
  render();
}

async function saveSnapshot(todos) {
  const response = await fetch(`/api/sessions/${state.sessionId}/todos`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ todos, version: state.version }),
  });
  const payload = await response.json();
  if (response.status === 409) {
    applySnapshot(payload);
    showStatus("任务已被其他窗口更新");
    return;
  }
  if (!response.ok) throw new Error(payload.error || "Todo 保存失败");
  applySnapshot(payload);
}

function connect() {
  state.stream?.close();
  state.stream = new EventSource(`/api/sessions/${state.sessionId}/todos/events`);
  state.stream.addEventListener("todo_updated", (event) => applySnapshot(JSON.parse(event.data)));
  state.stream.onerror = () => showStatus("实时连接断开，浏览器将自动重连");
}
```

`web/app.js` must also:

1. load `/api/sessions`, select the `session` query parameter or newest session;
2. load `/api/sessions/:id/todos` and store `{ todos, version }`;
3. subscribe with `new EventSource(`/api/sessions/${id}/todos/events`)`;
4. submit complete snapshots with the current `version` using `PUT`;
5. on `409`, replace local state with `body.todos/body.version` and display a conflict message;
6. close and reconnect the EventSource after errors;
7. render text using `textContent` or DOM node properties, never unsanitized HTML.

Use the existing application’s restrained dark palette, keep cards at a small radius, and provide a responsive single-column layout under 720px. The browser page must not contain any API key or model configuration field.

In `createAgentServer`, register `app.use(express.static(path.join(PACKAGE_ROOT, "web")))` before the JSON 404 fallback, so `/api/...` remains authoritative and `/` serves `web/index.html`.

- [ ] **Step 4: Run static and API tests**

Run `pnpm exec tsx --test test/server.test.ts test/server-todo-sse.test.ts`. Expected: static page and Todo API/SSE tests pass.

- [ ] **Step 5: Commit**

```text
git add web/index.html web/app.js web/styles.css src/server.ts test/server.test.ts
git commit -m "feat: add real-time web todo view"
```

## Task 8: Full Verification and Integration

**Files:**
- Modify: implementation/test files only if a verification failure identifies a real defect.

- [ ] **Step 1: Run focused regression tests**

```text
pnpm exec tsx --test test/todo.test.ts test/session-store.test.ts test/server.test.ts test/server-todo-sse.test.ts test/tui-todo.test.ts test/tui-todo-commands.test.ts test/tui-autocomplete.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 2: Run typecheck**

Run `pnpm run typecheck`. Expected: exit code `0`.

- [ ] **Step 3: Run the complete test suite**

Run `pnpm test`. Expected: all tests pass, with any pre-existing Windows symlink limitation recorded separately if it recurs.

- [ ] **Step 4: Smoke-test the served Web page**

Start the server with the existing local development entry point on an unused port, create a session through `/api/sessions`, open `/?session=<id>`, and verify the page shows an empty Todo list. PUT a Todo snapshot and verify the page updates through SSE. Delete the temporary session afterward.

- [ ] **Step 5: Inspect the final diff**

Run:

```text
git diff --check
git status --short
git log --oneline -10
```

Expected: only the documented source, test, Web, and plan/spec files are changed; no generated dependencies or credentials are present.

- [ ] **Step 6: Commit any verification fixes**

For each real defect found during verification, add the regression test first, make the smallest fix, rerun the failing command, and commit with a focused message such as `fix: preserve todo version on restore`.
