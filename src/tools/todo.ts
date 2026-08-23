import type { Tool } from "./types.ts";

export type TodoStatus = "pending" | "in_progress" | "completed";

export type TodoItem = {
  id: string;
  content: string;
  status: TodoStatus;
  activeForm?: string;
};

export type TodoWriteArgs = {
  todos: TodoItem[];
};

const TODO_STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed"]);
const MAX_TODO_ITEMS = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function validateTodoSnapshot(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) throw new Error("todos must be an array");
  if (value.length > MAX_TODO_ITEMS) throw new Error(`todos cannot contain more than ${MAX_TODO_ITEMS} items`);

  const ids = new Set<string>();
  let activeCount = 0;

  return value.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`todo ${index + 1} must be an object`);

    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) throw new Error(`todo ${index + 1} id must be non-empty`);
    if (ids.has(id)) throw new Error(`todo ids must be unique: ${id}`);
    ids.add(id);

    const content = typeof raw.content === "string" ? raw.content.trim() : "";
    if (!content) throw new Error(`todo ${id} content must be non-empty`);

    const status = raw.status;
    if (typeof status !== "string" || !TODO_STATUSES.has(status as TodoStatus)) {
      throw new Error(`todo ${id} status must be pending, in_progress, or completed`);
    }
    if (status === "in_progress") {
      activeCount++;
      if (activeCount > 1) throw new Error("todo list can contain at most one in_progress item");
    }

    const activeForm = raw.activeForm;
    if (activeForm !== undefined && typeof activeForm !== "string") {
      throw new Error(`todo ${id} activeForm must be a string`);
    }

    return {
      id,
      content,
      status: status as TodoStatus,
      ...(typeof activeForm === "string" && activeForm.trim()
        ? { activeForm: activeForm.trim() }
        : {}),
    };
  });
}

export function createTodoTool(onUpdate: (todos: TodoItem[]) => void | Promise<void>): Tool {
  return {
    name: "todo_write",
    displayName: "Update todos",
    description: [
      "Maintain the agent's task checklist in the TUI.",
      "Always send the complete todo snapshot, not a patch.",
      "Use pending, in_progress, or completed status; keep at most one item in_progress.",
      "Update the list when work starts, changes, or finishes.",
    ].join(" "),
    annotations: { readOnlyHint: true, idempotentHint: true },
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              activeForm: { type: "string" },
            },
            required: ["id", "content", "status"],
          },
        },
      },
      required: ["todos"],
    },
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
