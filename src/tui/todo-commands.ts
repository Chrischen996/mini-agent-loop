import type { TodoViewMode } from "../todo.ts";

export const TODO_COMMAND_USAGE = "/tasks [show|hide|compact|expanded|clear]";

export type TodoCommand = "toggle" | "show" | "hide" | "compact" | "expanded" | "clear";

import type { TodoItem, TodoStatus } from "../todo.ts";
import type { TuiAction } from "./state.ts";

export type LegacyTodoCommand =
  | { action: "list" }
  | { action: "add"; content: string }
  | { action: "start"; id: string }
  | { action: "pending"; id: string }
  | { action: "done"; id: string }
  | { action: "edit"; id: string; content: string }
  | { action: "delete"; id: string }
  | { action: "clear" };

export type TodoCommandResult = { ok: true; todos: TodoItem[] } | { ok: false; todos: TodoItem[]; error: string };

export function parseLegacyTodoCommand(input: string): LegacyTodoCommand | null {
  const parts = input.trim().replace(/^\//, "").split(/\s+/);
  if (parts[0]?.toLowerCase() !== "todo") return null;
  const action = parts[1]?.toLowerCase();
  if (!action) return { action: "list" };
  if (action === "clear") return parts.length === 2 ? { action: "clear" } : null;
  if (action === "add") {
    const content = parts.slice(2).join(" ").trim();
    return content ? { action: "add", content } : null;
  }
  const id = parts[2]?.trim();
  if (!id) return null;
  if (action === "start" || action === "pending" || action === "done") return parts.length === 3 ? { action, id } as LegacyTodoCommand : null;
  if (action === "edit") {
    const content = parts.slice(3).join(" ").trim();
    return content ? { action: "edit", id, content } : null;
  }
  return action === "delete" && parts.length === 3 ? { action: "delete", id } : null;
}

export function applyTodoCommand(todos: TodoItem[], command: LegacyTodoCommand): TodoCommandResult {
  const previous = todos.map((todo) => ({ ...todo }));
  if (command.action === "list") return { ok: true, todos: previous };
  if (command.action === "clear") return { ok: true, todos: [] };
  if (command.action === "add") {
    const content = command.content.trim();
    if (!content) return { ok: false, todos: previous, error: "Todo content must be non-empty" };
    let index = 1;
    while (todos.some((todo) => todo.id === `todo-${index}`)) index += 1;
    return { ok: true, todos: [...previous, { id: `todo-${index}`, content, activeForm: content, status: "pending", source: "model" }] };
  }
  const index = todos.findIndex((todo) => todo.id === command.id);
  if (index < 0) return { ok: false, todos: previous, error: `Todo not found: ${command.id}` };
  if (command.action === "edit") {
    const content = command.content.trim();
    if (!content) return { ok: false, todos: previous, error: "Todo content must be non-empty" };
    const next = [...previous]; next[index] = { ...next[index], content, activeForm: content }; return { ok: true, todos: next };
  }
  if (command.action === "delete") return { ok: true, todos: previous.filter((todo) => todo.id !== command.id) };
  const status: TodoStatus = command.action === "start" ? "in_progress" : command.action === "pending" ? "pending" : "completed";
  return { ok: true, todos: previous.map((todo) => ({ ...todo, status: todo.id === command.id ? status : status === "in_progress" && todo.status === "in_progress" ? "pending" : todo.status })) };
}

export function executeTodoCommand(todos: TodoItem[], command: LegacyTodoCommand, dispatch: (action: Extract<TuiAction, { type: "SET_TODOS" | "ADD_NOTICE" }>) => void): TodoCommandResult {
  const result = applyTodoCommand(todos, command);
  if (result.ok) dispatch({ type: "SET_TODOS", todos: result.todos });
  const text = result.ok
    ? (result.todos.length === 0 ? "Todo list is empty." : result.todos.map((todo) => `${todo.id} [${todo.status}] ${todo.content}`).join("\n"))
    : result.error;
  dispatch({ type: "ADD_NOTICE", title: "Todo", text });
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
