import type { TodoItem, TodoStatus } from "../tools/todo.ts";
import type { TuiAction } from "./state.ts";

export type TodoCommand =
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

type TodoDispatch = (action: Extract<TuiAction, { type: "SET_TODOS" | "ADD_NOTICE" }>) => void;

function cloneTodos(todos: TodoItem[]): TodoItem[] {
  return todos.map((todo) => ({ ...todo }));
}

function parseId(value: string | undefined): string | null {
  const id = value?.trim() ?? "";
  return id || null;
}

export function parseTodoCommand(input: string): TodoCommand | null {
  const text = input.trim().replace(/^\//, "");
  const parts = text.split(/\s+/);
  if (parts[0]?.toLowerCase() !== "todo") return null;
  const action = parts[1]?.toLowerCase();
  if (!action) return { action: "list" };
  if (action === "clear") return parts.length === 2 ? { action: "clear" } : null;
  if (action === "add") {
    const content = parts.slice(2).join(" ").trim();
    return content ? { action: "add", content } : null;
  }
  const id = parseId(parts[2]);
  if (!id) return null;
  if (action === "start" || action === "pending" || action === "done") {
    return parts.length === 3 ? { action, id } : null;
  }
  if (action === "edit") {
    const content = parts.slice(3).join(" ").trim();
    return content ? { action: "edit", id, content } : null;
  }
  if (action === "delete") return parts.length === 3 ? { action: "delete", id } : null;
  return null;
}

function withStatus(todos: TodoItem[], targetId: string, status: TodoStatus): TodoItem[] {
  return todos.map((todo) => ({
    ...todo,
    status: status === "in_progress" && todo.id !== targetId && todo.status === "in_progress"
      ? "pending"
      : todo.id === targetId ? status : todo.status,
  }));
}

export function applyTodoCommand(todos: TodoItem[], command: TodoCommand): TodoCommandResult {
  const previous = cloneTodos(todos);
  if (command.action === "list") return { ok: true, todos: previous };
  if (command.action === "clear") return { ok: true, todos: [] };

  if (command.action === "add") {
    const content = command.content.trim();
    if (!content) return { ok: false, todos: previous, error: "Todo content must be non-empty" };
    let index = 1;
    while (todos.some((todo) => todo.id === `todo-${index}`)) index += 1;
    return {
      ok: true,
      todos: [...previous, { id: `todo-${index}`, content, status: "pending" }],
    };
  }

  const targetIndex = todos.findIndex((todo) => todo.id === command.id);
  if (targetIndex < 0) return { ok: false, todos: previous, error: `Todo not found: ${command.id}` };
  if (command.action === "edit") {
    const content = command.content.trim();
    if (!content) return { ok: false, todos: previous, error: "Todo content must be non-empty" };
    const next = cloneTodos(todos);
    next[targetIndex] = { ...next[targetIndex], content };
    return { ok: true, todos: next };
  }
  if (command.action === "delete") {
    return { ok: true, todos: previous.filter((todo) => todo.id !== command.id) };
  }
  const status = command.action === "start"
    ? "in_progress"
    : command.action === "pending" ? "pending" : "completed";
  return { ok: true, todos: withStatus(previous, command.id, status) };
}

function formatTodoNotice(todos: TodoItem[]): string {
  if (todos.length === 0) return "Todo list is empty.";
  return todos.map((todo) => `${todo.id} [${todo.status}] ${todo.content}`).join("\n");
}

export function executeTodoCommand(
  todos: TodoItem[],
  command: TodoCommand,
  dispatch: TodoDispatch,
): TodoCommandResult {
  const result = applyTodoCommand(todos, command);
  if (!result.ok) {
    dispatch({ type: "ADD_NOTICE", title: "Todo", text: `Todo command failed: ${result.error}` });
    return result;
  }
  dispatch({ type: "SET_TODOS", todos: result.todos });
  dispatch({ type: "ADD_NOTICE", title: "Todo", text: formatTodoNotice(result.todos) });
  return result;
}
