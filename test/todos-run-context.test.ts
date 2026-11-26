import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildTodosRunContext,
  resolveTodosRunArgs,
  type TodosRunContextInput,
} from "../src/tui/todos-run-context.ts";
import { createInitialState, type TuiAction, type TuiState } from "../src/tui/state.ts";
import { PermissionManager } from "../src/permissions.ts";
import { makeLlmConfig } from "../src/llm/index.ts";

const llm = makeLlmConfig({ apiKey: "k", baseUrl: "http://localhost/v1", model: "faux" });
const state = createInitialState(llm.model) as TuiState;

const parsedArgs = { parallel: true, dryRun: true, raw: "/tasks run --parallel", only: [], deps: {}, model: {}, files: {}, maxConcurrency: 2, confirm: false } as TodosRunContextInput["rawParsedArgs"];

function baseInput(overrides: Partial<TodosRunContextInput> = {}): TodosRunContextInput & { dispatched: TuiAction[] } {
  const dispatched: TuiAction[] = [];
  const input: TodosRunContextInput = {
    getState: () => state,
    dispatch: (action) => dispatched.push(action),
    sessionId: "sess-1",
    permissionManager: new PermissionManager("plan"),
    cwd: "/proj",
    allTools: {} as TodosRunContextInput["allTools"],
    abortSignal: new AbortController().signal,
    todosRunExecutors: {} as TodosRunContextInput["todosRunExecutors"],
    clearInput: () => undefined,
    onConfirmTodoRun: () => undefined,
    todoRunConfirmed: false,
    rawParsedArgs: parsedArgs,
    ...overrides,
  };
  return Object.assign(input, { dispatched });
}

describe("buildTodosRunContext", () => {
  it("wires a store adapter that reads live state and forwards dispatch", () => {
    const input = baseInput();
    const ctx = buildTodosRunContext(input);
    assert.equal(ctx.store.getState(), state, "getState reads the live state");
    const action = { type: "ADD_NOTICE", title: "T", text: "x" } as never;
    ctx.store.dispatch(action);
    assert.deepEqual((input as never as { dispatched: TuiAction[] }).dispatched, [action]);
    // Subscription is a no-op one-shot, as in the component.
    const unsub = ctx.store.subscribe(() => undefined);
    assert.equal(typeof unsub, "function");
    assert.equal(ctx.store.subscribe(() => undefined)(), undefined);
  });

  it("captures the session id as of assembly time", () => {
    const ctx = buildTodosRunContext(baseInput({ sessionId: "sess-9" }));
    assert.equal(ctx.sessionRef.current, "sess-9");
  });

  it("keeps clearInput live and recordSubmission/persistTodoState fire-and-forget", () => {
    let cleared = 0;
    const ctx = buildTodosRunContext(baseInput({
      clearInput: () => { cleared += 1; },
    }));
    ctx.clearInput();
    assert.equal(cleared, 1, "clearInput forwards to the live setter");
    assert.equal(ctx.recordSubmission("/tasks run"), undefined);
    assert.equal(ctx.persistTodoState?.([]), undefined);
  });

  it("forwards the plan-confirmation handshake unchanged", () => {
    const confirmed: string[] = [];
    const ctx = buildTodosRunContext(baseInput({
      todoRunConfirmed: true,
      todoRunSnapshot: [{ id: "t1", content: "do it", status: "pending" } as never],
      onConfirmTodoRun: (pending) => { confirmed.push(pending.parsed.raw); },
    }));
    assert.equal(ctx.todoRunConfirmed, true);
    assert.equal(ctx.todoRunSnapshot?.length, 1);
    ctx.onConfirmTodoRun?.({ parsed: { raw: "/tasks run --parallel" } } as never);
    assert.deepEqual(confirmed, ["/tasks run --parallel"]);
  });

  it("resolveTodosRunArgs prefers the approved plan over raw args", () => {
    const approved = { ...parsedArgs, raw: "/tasks run --parallel --only a" };
    assert.deepEqual(resolveTodosRunArgs(approved, parsedArgs), { cmd: "todos-run", args: approved });
    assert.deepEqual(resolveTodosRunArgs(undefined, parsedArgs), { cmd: "todos-run", args: parsedArgs });
  });
});
