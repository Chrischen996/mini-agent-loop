import type { TodoViewMode } from "../todo.ts";

export const TODO_COMMAND_USAGE = "/tasks [show|hide|compact|expanded|clear]";

export type TodoCommand = "toggle" | "show" | "hide" | "compact" | "expanded" | "clear";

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
