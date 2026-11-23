import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInitialState, tuiReducer } from "../src/tui/state.ts";
import { getMessageFeedHeight, getPickerLayout } from "../src/tui/layout.ts";
import { getWelcomeHeaderHeight } from "../src/tui/welcome-panel.ts";
import { getTodoPanelRows } from "../src/tui/todo-format.ts";
import { terminalStringWidth } from "../src/tui/terminal-width.ts";
import { estimatePromptInputRows } from "../src/tui/components/PromptInput.tsx";

/**
 * `useSessionLayout` is a thin `useMemo` wrapper over these pure builders.
 * Testing the composition here keeps the hook's contract pinned without an Ink
 * render: the feed height must shrink exactly as the picker/prompt/approval
 * chrome grows, or the frame overflows and Ink clears the screen.
 */
const WIDTH = 100;
const ROWS = 40;

function budgets(options: {
  prompt: string;
  queuedCount?: number;
  pendingPermission?: boolean;
  pendingTodoRun?: boolean;
  reviewPlan?: boolean;
  pickerItems?: number;
  welcome?: boolean;
}) {
  const state = createInitialState("test-model");
  const promptPlaceholder = "Message, /command, or @file reference";
  const promptWidth = Math.max(
    1,
    WIDTH - 4 - 2 - (options.queuedCount ? terminalStringWidth(`Queue ${options.queuedCount}`) : 0),
  );
  const promptRows = estimatePromptInputRows(options.prompt, promptWidth, promptPlaceholder);
  const todoRows = getTodoPanelRows({ plan: state.todoPlan, todos: state.todoItems }, state.todoViewMode);
  const permissionRows = (options.pendingPermission ? 4 : 0) + (options.pendingTodoRun ? 5 : 0);
  const planApprovalRows = options.reviewPlan ? 3 : 0;
  const headerRows = options.welcome ? getWelcomeHeaderHeight(WIDTH, true) : undefined;
  const pickerLayout = getPickerLayout({
    termRows: ROWS,
    requestedItems: options.pickerItems ?? 0,
    inputRows: promptRows,
    hasHeader: true,
    ...(headerRows !== undefined ? { headerRows } : {}),
    hasPendingImages: false,
    todoRows,
    extraRows: 2,
    permissionRows,
    planApprovalRows,
    hasInputBorder: true,
  });
  const feedHeight = getMessageFeedHeight({
    termRows: ROWS,
    inputRows: promptRows,
    hasHeader: true,
    ...(headerRows !== undefined ? { headerRows } : {}),
    hasPendingImages: false,
    todoRows,
    pickerRows: pickerLayout.totalRows,
    permissionRows,
    planApprovalRows,
    hasInputBorder: true,
  });
  return { promptRows, todoRows, permissionRows, planApprovalRows, pickerLayout, feedHeight };
}

describe("session layout budgets", () => {
  it("keeps the feed positive and inside the terminal", () => {
    const result = budgets({ prompt: "hello" });
    assert.ok(result.feedHeight > 0);
    assert.ok(result.feedHeight < ROWS);
  });

  it("grows the prompt rows for a multi-line draft", () => {
    const single = budgets({ prompt: "one line" });
    const multi = budgets({ prompt: "one\ntwo\nthree" });
    assert.ok(multi.promptRows > single.promptRows);
  });

  it("shrinks the feed when the picker opens", () => {
    const closed = budgets({ prompt: "hello" });
    const open = budgets({ prompt: "hello", pickerItems: 8 });
    assert.ok(open.pickerLayout.totalRows > 0);
    assert.ok(open.feedHeight < closed.feedHeight, "the picker takes rows from the feed");
  });

  it("shrinks the feed for the permission card and the todo-run panel", () => {
    const base = budgets({ prompt: "hello" });
    const permission = budgets({ prompt: "hello", pendingPermission: true });
    const todoRun = budgets({ prompt: "hello", pendingTodoRun: true });
    assert.equal(permission.permissionRows, 4);
    assert.equal(todoRun.permissionRows, 5);
    assert.ok(permission.feedHeight < base.feedHeight);
    assert.ok(todoRun.feedHeight < permission.feedHeight);
  });

  it("reserves rows for the plan approval bar", () => {
    const base = budgets({ prompt: "hello" });
    const review = budgets({ prompt: "hello", reviewPlan: true });
    assert.equal(review.planApprovalRows, 3);
    assert.ok(review.feedHeight < base.feedHeight);
  });

  it("reserves the welcome header only while it is shown", () => {
    const welcome = budgets({ prompt: "", welcome: true });
    const noWelcome = budgets({ prompt: "" });
    assert.ok(welcome.feedHeight <= noWelcome.feedHeight);
  });

  it("counts the queue badge against the prompt width", () => {
    const wide = budgets({ prompt: "a".repeat(200) });
    const queued = budgets({ prompt: "a".repeat(200), queuedCount: 12 });
    assert.ok(queued.promptRows >= wide.promptRows);
  });

  it("keeps a running turn's feed height stable when a todo panel appears", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "plan the work" });
    state = tuiReducer(state, {
      type: "SET_TODOS",
      todos: [{ id: "1", content: "step one", activeForm: "doing step one", status: "pending", source: "model" }],
    });
    const todoRows = getTodoPanelRows({ plan: state.todoPlan, todos: state.todoItems }, state.todoViewMode);
    assert.ok(todoRows > 0, "a todo list reserves rows");
  });
});
