import {
  MAX_TODO_ITEMS,
  MAX_TODO_TEXT_LENGTH,
  TODO_WRITE_TOOL_NAME,
  normalizeTodoWriteInput,
  todoSummary,
  type TodoItem,
  type TodoWriteInputItem,
} from "../todo.ts";
import type { Tool, ToolResult } from "./types.ts";

export type TodoWriteArgs = {
  todos: TodoWriteInputItem[];
};

export function createTodoWriteTool(): Tool<TodoWriteArgs> {
  const tool: Tool<TodoWriteArgs> = {
    name: TODO_WRITE_TOOL_NAME,
    displayName: "TodoWrite",
    description: "Replace the current task list with a concise set of pending, in-progress, and completed tasks.",
    annotations: {
      title: "Update task list",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
    },
    capabilities: {
      writeWorkspace: false,
      executeProcess: false,
      network: false,
      externalData: false,
      destructive: false,
      requiresApproval: false,
    },
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        todos: {
          type: "array",
          minItems: 0,
          maxItems: MAX_TODO_ITEMS,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["content", "activeForm", "status"],
            properties: {
              content: { type: "string", minLength: 1, maxLength: MAX_TODO_TEXT_LENGTH },
              activeForm: { type: "string", minLength: 1, maxLength: MAX_TODO_TEXT_LENGTH },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
          },
        },
      },
      required: ["todos"],
    },
    async execute(args): Promise<ToolResult> {
      try {
        const todos: TodoItem[] = normalizeTodoWriteInput(args);
        const summary = todoSummary(todos);
        return {
          content: `Todo list updated: ${summary.completed}/${summary.total} completed, ${summary.inProgress} in progress, ${summary.open} open.`,
          todoUpdate: todos,
        };
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
  };
  return tool;
}
