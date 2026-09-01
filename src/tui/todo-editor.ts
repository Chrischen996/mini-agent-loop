import type { TodoItem, TodoStatus } from "../todo.ts";
import { applyTodoCommand, type LegacyTodoCommand } from "./todo-commands.ts";

export type TodoEditorMode = "select" | "add" | "edit";

export type TodoEditorState = {
  todos: TodoItem[];
  selectedIndex: number;
  mode: TodoEditorMode;
  draft: string;
  editingId?: string;
  error?: string;
};

export type TodoEditorAction =
  | { type: "MOVE"; delta: number }
  | { type: "CYCLE_STATUS" }
  | { type: "DELETE" }
  | { type: "BEGIN_ADD" }
  | { type: "BEGIN_EDIT" }
  | { type: "INPUT"; value: string }
  | { type: "CONFIRM" }
  | { type: "CANCEL" };

function cloneTodos(todos: readonly TodoItem[]): TodoItem[] {
  return todos.map((todo) => ({ ...todo }));
}

export function createTodoEditorState(todos: readonly TodoItem[]): TodoEditorState {
  return { todos: cloneTodos(todos), selectedIndex: 0, mode: "select", draft: "" };
}

function selectedTodo(state: TodoEditorState): TodoItem | undefined {
  return state.todos[state.selectedIndex];
}

function cycleStatus(status: TodoStatus): TodoStatus {
  return status === "pending" ? "in_progress" : status === "in_progress" ? "completed" : "pending";
}

export function reduceTodoEditor(state: TodoEditorState, action: TodoEditorAction): TodoEditorState {
  switch (action.type) {
    case "MOVE":
      return {
        ...state,
        selectedIndex: Math.max(0, Math.min(Math.max(0, state.todos.length - 1), state.selectedIndex + action.delta)),
        error: undefined,
      };

    case "CYCLE_STATUS": {
      const todo = selectedTodo(state);
      if (!todo) return state;
      const status = cycleStatus(todo.status);
      const todos = state.todos.map((item) => ({
        ...item,
        status: status === "in_progress" && item.id !== todo.id && item.status === "in_progress"
          ? "pending"
          : item.id === todo.id ? status : item.status,
      }));
      return { ...state, todos, error: undefined };
    }

    case "DELETE": {
      const todo = selectedTodo(state);
      if (!todo) return state;
      const todos = state.todos.filter((item) => item.id !== todo.id);
      return {
        ...state,
        todos,
        selectedIndex: Math.min(state.selectedIndex, Math.max(0, todos.length - 1)),
        error: undefined,
      };
    }

    case "BEGIN_ADD":
      return { ...state, mode: "add", draft: "", editingId: undefined, error: undefined };

    case "BEGIN_EDIT": {
      const todo = selectedTodo(state);
      return todo
        ? { ...state, mode: "edit", draft: todo.content, editingId: todo.id, error: undefined }
        : state;
    }

    case "INPUT":
      return { ...state, draft: action.value, error: undefined };

    case "CANCEL":
      return { ...state, mode: "select", draft: "", editingId: undefined, error: undefined };

    case "CONFIRM": {
      let command: LegacyTodoCommand;
      if (state.mode === "add") command = { action: "add", content: state.draft };
      else if (state.mode === "edit" && state.editingId) command = { action: "edit", id: state.editingId, content: state.draft };
      else return state;

      const result = applyTodoCommand(state.todos, command);
      if (!result.ok) return { ...state, error: result.error };
      return {
        ...state,
        todos: result.todos,
        selectedIndex: state.mode === "add" ? Math.max(0, result.todos.length - 1) : state.selectedIndex,
        mode: "select",
        draft: "",
        editingId: undefined,
        error: undefined,
      };
    }
  }
}

/** Select-mode Enter is a no-op; add/edit mode confirms the current draft. */
export function confirmTodoEditor(state: TodoEditorState): TodoEditorState {
  return state.mode === "select" ? state : reduceTodoEditor(state, { type: "CONFIRM" });
}
