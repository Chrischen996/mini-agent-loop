import type { TodoViewMode } from "../todo.ts";
import { normalizeTodoText, type TodoItem, type TodoStatus } from "../todo.ts";
import type { TuiAction } from "./state.ts";

export const TODO_COMMAND_USAGE = "/tasks [show|hide|compact|expanded|clear]";

export type TodoCommand = "toggle" | "show" | "hide" | "compact" | "expanded" | "clear";

/** Commands that mutate the session-scoped manual Todo list. */
export type LegacyTodoCommand =
  | { action: "list" }
  | { action: "add"; content: string }
  | { action: "start"; id: string }
  | { action: "pending"; id: string }
  | { action: "done"; id: string }
  | { action: "edit"; id: string; content: string }
  | { action: "delete"; id: string }
  | { action: "clear" };

export type TodoCommandResult =
  | { ok: true; todos: TodoItem[] }
  | { ok: false; todos: TodoItem[]; error: string };

/** Parse a complete /todo command. Returns null for ordinary prompt input. */
export function parseLegacyTodoCommand(input: string): LegacyTodoCommand | null {
  const parts = input.trim().replace(/^\//, "").split(/\s+/);
  if (parts[0]?.toLowerCase() !== "todo") return null;

  const action = parts[1]?.toLowerCase();
  if (!action) return { action: "list" };
  if (action === "clear") return parts.length === 2 ? { action: "clear" } : null;
  if (action === "add") {
    const content = normalizeTodoText(parts.slice(2).join(" "));
    return content ? { action: "add", content } : null;
  }

  const id = parts[2]?.trim();
  if (!id) return null;
  if (action === "start" || action === "pending" || action === "done") {
    return parts.length === 3 ? { action, id } : null;
  }
  if (action === "edit") {
    const content = normalizeTodoText(parts.slice(3).join(" "));
    return content ? { action: "edit", id, content } : null;
  }
  return action === "delete" && parts.length === 3 ? { action: "delete", id } : null;
}

function cloneTodos(todos: readonly TodoItem[]): TodoItem[] {
  return todos.map((todo) => ({ ...todo }));
}

function nextManualTodoId(todos: readonly TodoItem[]): string {
  let index = 1;
  while (todos.some((todo) => todo.id === `todo-${index}`)) index += 1;
  return `todo-${index}`;
}

function withStatus(todos: readonly TodoItem[], targetId: string, status: TodoStatus): TodoItem[] {
  return todos.map((todo) => ({
    ...todo,
    status: status === "in_progress" && todo.id !== targetId && todo.status === "in_progress"
      ? "pending"
      : todo.id === targetId ? status : todo.status,
  }));
}

/** Apply one manual command without mutating the supplied Todo snapshot. */
export function applyTodoCommand(todos: TodoItem[], command: LegacyTodoCommand): TodoCommandResult {
  const previous = cloneTodos(todos);
  if (command.action === "list") return { ok: true, todos: previous };
  if (command.action === "clear") return { ok: true, todos: [] };

  if (command.action === "add") {
    const content = normalizeTodoText(command.content);
    if (!content) return { ok: false, todos: previous, error: "Todo content must be non-empty" };
    return {
      ok: true,
      todos: [
        ...previous,
        {
          id: nextManualTodoId(todos),
          content,
          activeForm: content,
          status: "pending",
          source: "model",
        },
      ],
    };
  }

  const targetIndex = todos.findIndex((todo) => todo.id === command.id);
  if (targetIndex < 0) return { ok: false, todos: previous, error: `Todo not found: ${command.id}` };

  if (command.action === "edit") {
    const content = normalizeTodoText(command.content);
    if (!content) return { ok: false, todos: previous, error: "Todo content must be non-empty" };
    const next = cloneTodos(todos);
    next[targetIndex] = { ...next[targetIndex]!, content, activeForm: content };
    return { ok: true, todos: next };
  }
  if (command.action === "delete") {
    return { ok: true, todos: previous.filter((todo) => todo.id !== command.id) };
  }

  const status: TodoStatus = command.action === "start"
    ? "in_progress"
    : command.action === "pending" ? "pending" : "completed";
  return { ok: true, todos: withStatus(previous, command.id, status) };
}

function formatTodoNotice(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return "Todo list is empty.";
  return todos.map((todo) => `${todo.id} [${todo.status}] ${todo.content}`).join("\n");
}

type TodoDispatch = (action: Extract<TuiAction, { type: "SET_TODOS" | "ADD_NOTICE" }>) => void;

/** Apply a command and report the result without starting an Agent turn. */
export function executeTodoCommand(
  todos: TodoItem[],
  command: LegacyTodoCommand,
  dispatch: TodoDispatch,
): TodoCommandResult {
  const result = applyTodoCommand(todos, command);
  if (result.ok) dispatch({ type: "SET_TODOS", todos: result.todos });
  dispatch({ type: "ADD_NOTICE", title: "Todo", text: result.ok ? formatTodoNotice(result.todos) : result.error });
  return result;
}

const TODO_COMMAND_PATTERN = /^\/tasks(?:\s+(show|hide|compact|expanded|clear))?$/i;

/** Parse a complete /tasks command. Returns undefined for normal user input. */
export function parseTodoCommand(input: string): TodoCommand | undefined {
  const match = input.trim().match(TODO_COMMAND_PATTERN);
  if (!match) return undefined;
  return (match[1]?.toLowerCase() as TodoCommand | undefined) ?? "toggle";
}

/** Resolve the panel mode for a command that does not clear the task list. */
export function todoViewModeForCommand(command: Exclude<TodoCommand, "clear">, current: TodoViewMode): TodoViewMode {
  switch (command) {
    case "show":
    case "expanded":
      return "expanded";
    case "hide":
      return "hidden";
    case "compact":
      return "compact";
    case "toggle":
      return current === "expanded" ? "compact" : "expanded";
  }
}
