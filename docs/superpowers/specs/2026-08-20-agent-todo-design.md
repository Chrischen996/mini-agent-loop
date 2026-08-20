# Agent Todo TUI Design

## Context

The Ink TUI currently shows conversation output, tool activity, and the input
prompt, but it has no independent task list that the agent can update while a
task is in progress. Existing `WorkflowStep` and `ExecutionPlan` state is tied
to tool calls or the `/plan` workflow and should remain separate.

## Goals

- Give the TUI an independent todo list managed by the agent.
- Render the list directly above the input prompt in a compact Claude Code-like
  checklist.
- Show pending, active, and completed work without requiring user interaction.
- Keep the last valid list when an update is rejected or fails.
- Keep terminal height calculations correct while the list is visible.
- Reset the list with `/clear`.

## Non-goals

- Reusing `/plan` steps or tool-call steps as todo items.
- Parsing Markdown checkboxes from assistant text.
- Persisting todos to disk or restoring them across sessions.
- Allowing the user to edit, reorder, or toggle todo items from the TUI.

## Data Model

Add an independent todo model:

```ts
type TodoStatus = "pending" | "in_progress" | "completed";

type TodoItem = {
  id: string;
  content: string;
  status: TodoStatus;
  activeForm?: string;
};
```

`activeForm` is optional text used while an item is in progress, for example
`"Running tests"` instead of `"Run tests"`.

Add `todos: TodoItem[]` to `TuiState` and a reducer action that replaces the
whole list atomically. A todo update is a snapshot, not a patch, so the TUI
cannot retain stale items after the agent has re-planned.

The list accepts at most one `in_progress` item. Item ids must be unique and
content must be non-empty after trimming. Invalid snapshots are rejected by
the tool before the reducer is called.

## Agent Integration

Add a local `todo_write` tool for the Ink TUI. The tool accepts a complete
`todos` array and returns a concise result containing the number of pending,
active, and completed items. Its callback dispatches the validated snapshot to
the TUI state.

The tool is marked safe and idempotent because it only changes in-memory TUI
state and never touches workspace files. It is included in the TUI agent tool
provider and described in the agent prompt so the agent knows to use it when a
task has multiple steps, to keep at most one current item active, and to mark
items completed as work finishes.

The callback runs only after validation succeeds. Therefore a failed tool call
cannot partially update the visible list. The previous valid list remains
visible, while the normal tool error/status path reports the rejected update.

Raw `todo_write` activity should not add a noisy tool card to the conversation
feed. The dedicated panel is the user-facing representation; other tool
activity remains unchanged.

## TUI Rendering

Add a focused `TodoPanel` component rendered in the fixed chrome immediately
above pending image attachments and the prompt row:

```text
TODO  2/4
  ✓ Read the configuration
  ✓ Update the input component
  ▶ Run tests
  ○ Review the result
> input message...
```

Rendering rules:

- Hide the panel when the list is empty.
- Show a compact `TODO completed/total` header.
- Render `✓` for completed, `▶` for in-progress, and `○` for pending.
- Highlight the in-progress row using the existing TUI running color.
- Use `activeForm` for the in-progress row when present.
- Keep rows single-line with terminal-width truncation.
- Show at most six rows; add a final `… N more` line when there are more.
- Keep the panel read-only; no new keyboard shortcuts are introduced.
- Keep a completed list visible until the agent replaces it or `/clear` resets
  the conversation, so the user can see the result of the current task.

The panel's row count is included in the feed chrome calculation. This keeps
the scrollable message area from rendering into the terminal's final row when
todo items are present.

## State and Lifecycle

1. The agent calls `todo_write` with a full snapshot.
2. The tool validates the snapshot.
3. On success, its callback dispatches the replacement list.
4. React renders the panel above the prompt and recalculates feed height.
5. On invalid input or execution failure, the old list remains unchanged.
6. `/clear` recreates initial TUI state and removes all todos.

Todo state is independent of `goal`, `WorkflowStep[]`, `currentPlan`, and
`toolCards`; updates to any of those values must not mutate the todo list.

## Testing

- Unit-test todo snapshot validation: valid statuses, duplicate ids, empty
  content, and multiple active items.
- Unit-test `todo_write` success and failure behavior, including the callback
  firing only for valid snapshots.
- Unit-test reducer replacement and `/clear` reset behavior.
- Unit-test panel formatting for pending, active, completed, active-form text,
  truncation, and overflow summary.
- Unit-test feed-height calculations with zero, visible, and overflowing todo
  rows.
- Run the existing TUI, loop, and full test suites plus TypeScript typecheck.

## Acceptance Criteria

- An agent can call `todo_write` during a TUI turn and the checklist appears
  above the input without a manual refresh.
- Repeated calls replace the list and update the active/completed indicators.
- Invalid updates do not erase the last valid list.
- Completed todos remain visible until replaced or `/clear` is used.
- Long lists do not push Ink output into the terminal's last row.
- Existing plan, workflow-step, tool-card, input, and permission behavior is
  unchanged.
