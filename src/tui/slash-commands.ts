import { parseLegacyTodoCommand, type LegacyTodoCommand } from "./todo-commands.ts";

export type SlashCommand =
  | { cmd: "read"; path: string }
  | { cmd: "bash"; command: string }
  | { cmd: "ls"; path: string }
  | { cmd: "find"; pattern: string; path: string }
  | { cmd: "grep"; pattern: string; path: string }
  | { cmd: "todo"; todo: LegacyTodoCommand }
  | null;

export function parseSlashCommand(input: string): SlashCommand {
  const s = input.trim();
  if (!s.startsWith("/")) return null;
  const parts = s.slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  switch (cmd) {
    case "todo": {
      const todo = parseLegacyTodoCommand(s);
      return todo ? { cmd: "todo", todo } : null;
    }
    case "read": { const path = parts.slice(1).join(" "); return path ? { cmd: "read", path } : null; }
    case "bash": case "sh": { const command = parts.slice(1).join(" "); return command ? { cmd: "bash", command } : null; }
    case "ls": return { cmd: "ls", path: parts[1] ?? "." };
    case "find": return { cmd: "find", pattern: parts[1] ?? "*", path: parts[2] ?? "." };
    case "grep": { const pattern = parts[1] ?? ""; const path = parts[2] ?? "."; return pattern ? { cmd: "grep", pattern, path } : null; }
    default: return null;
  }
}

// Commands that accept a path argument (trigger file autocomplete after selection)
export const PATH_COMMANDS = new Set(["read", "ls", "find", "grep"]);

/** Commands that accept a finite or discoverable argument list. */
export const ARGUMENT_COMMANDS = new Set(["copy", "tasks", "todo", "skill", "skills", "resume"]);
