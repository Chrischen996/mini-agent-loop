import { parseLegacyTodoCommand, TODO_COMMAND_USAGE, type LegacyTodoCommand } from "./todo-commands.ts";

export type SlashCommand =
  | { cmd: "read"; path: string }
  | { cmd: "bash"; command: string }
  | { cmd: "ls"; path: string }
  | { cmd: "find"; pattern: string; path: string }
  | { cmd: "grep"; pattern: string; path: string }
  | { cmd: "todo"; todo: LegacyTodoCommand }
  | null;

export type CommandDef = {
  name: string;       // e.g. "read"
  usage: string;      // e.g. "/read <path>"
  description: string;
  /**
   * Alternative spelling of another catalog entry. Aliases stay selectable in
   * the palette and valid on the command line, but `/help` lists only the
   * canonical command so the same usage row is not printed twice.
   */
  alias?: boolean;
};

/**
 * The single command catalog.
 *
 * Both clients render their palette, their `/help` output, and their unknown
 * command guard from this list. It used to live inside an Ink component, which
 * made the ANSI entrypoint depend on a React module for plain data and left
 * `/help` describing a different set of commands than the palette offered.
 */
export const SLASH_COMMANDS: CommandDef[] = [
  { name: "model", usage: "/model [ref] [url] [key]", description: "Switch model and gateway" },
  { name: "profiles", usage: "/profiles", description: "List and activate model profiles" },
  { name: "image", usage: "/image <path>", description: "Attach a local image" },
  { name: "paste-image", usage: "/paste-image", description: "Attach an image from the clipboard" },
  { name: "read", usage: "/read <path>", description: "Read a file" },
  { name: "bash", usage: "/bash <cmd>", description: "Run a shell command" },
  { name: "ls", usage: "/ls [path]", description: "List a directory" },
  { name: "find", usage: "/find <glob> [path]", description: "Find files by glob" },
  { name: "grep", usage: "/grep <pattern> [path]", description: "Search file contents" },
  { name: "clear", usage: "/clear", description: "Clear the conversation" },
  { name: "sessions", usage: "/sessions", description: "List saved sessions" },
  { name: "resume", usage: "/resume [id]", description: "Resume a saved session" },
  { name: "tasks", usage: TODO_COMMAND_USAGE, description: "Show or manage todos" },
  { name: "todo", usage: TODO_COMMAND_USAGE, description: "Alias of /tasks", alias: true },
  { name: "context", usage: "/context", description: "Show context and token usage" },
  { name: "plan", usage: "/plan [task]", description: "Generate an execution plan (plan mode)" },
  { name: "plan-show", usage: "/plan-show", description: "Show the current plan" },
  { name: "plan-approve", usage: "/plan-approve", description: "Approve the current plan" },
  { name: "plan-reject", usage: "/plan-reject", description: "Reject the current plan" },
  { name: "plan-run", usage: "/plan-run", description: "Run the approved plan" },
  { name: "plan-retry", usage: "/plan-retry", description: "Retry a failed plan" },
  { name: "plan-history", usage: "/plan-history", description: "List plan history" },
  { name: "plan-archive", usage: "/plan-archive", description: "Archive the current plan" },
  { name: "copy", usage: "/copy [last|assistant|input|tool|thinking|user]", description: "Copy a message or transcript to the clipboard" },
  { name: "skill", usage: "/skill [on|off|list|clear] [name]", description: "Alias of /skills", alias: true },
  { name: "skills", usage: "/skills [on|off|list|clear] [name]", description: "Manage session skills" },
  { name: "help", usage: "/help", description: "Show help" },
  { name: "exit", usage: "/exit", description: "Alias of /quit", alias: true },
  { name: "quit", usage: "/quit", description: "Exit" },
];

/** Aliases and internal spellings that are handled but not advertised. */
const UNLISTED_COMMAND_NAMES = new Set(["?", "sh", "plan-edit", "plan-set-file", "plan-force"]);

export const KNOWN_SLASH_COMMAND_NAMES: ReadonlySet<string> = new Set([
  ...SLASH_COMMANDS.map((command) => command.name),
  ...UNLISTED_COMMAND_NAMES,
]);

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

/**
 * Detect a mistyped slash command.
 *
 * Without this guard an unknown `/command` was submitted to the model as an
 * ordinary prompt, spending a turn on a typo. A leading `/` only counts as a
 * command when the first token is a bare word, so prompts that start with an
 * absolute path (`/home/user/x is broken`) are still sent to the model.
 */
export function parseUnknownSlashCommand(input: string): string | undefined {
  const trimmed = input.trim();
  const match = /^\/([a-zA-Z][a-zA-Z0-9_-]*)(?=\s|$)/.exec(trimmed);
  if (!match) return undefined;
  const name = match[1]!.toLowerCase();
  return KNOWN_SLASH_COMMAND_NAMES.has(name) ? undefined : `/${name}`;
}

/** Widest usage column the command palette and `/help` may use. */
export const COMMAND_USAGE_COLUMN_MAX = 46;

/**
 * Shared usage-column width for the command palette.
 *
 * Both clients pad the usage to this column so descriptions line up; computing
 * it per renderer is what made the Ink palette ragged while the ANSI overlay
 * was aligned.
 */
export function commandUsageColumn(commands: readonly CommandDef[]): number {
  if (commands.length === 0) return 0;
  return Math.min(COMMAND_USAGE_COLUMN_MAX, Math.max(...commands.map((command) => command.usage.length)) + 2);
}

/** Keybindings listed at the bottom of `/help`, packed to the terminal width. */
export const HELP_KEYBIND_HINTS: readonly string[] = [
  "Tab/↑↓ pick a command",
  "Enter run",
  "Esc close",
  "Shift+Tab permission mode",
  "Ctrl+R reasoning level",
  "Alt+T expand reasoning",
  "Alt+↑/↓ focus message",
  "Ctrl+Shift+T todo editor",
  "Ctrl+G jump to bottom",
  "PageUp/PageDown scroll",
];

const HELP_HINT_SEPARATOR = "  ·  ";
function packHints(hints: readonly string[], width: number): string[] {
  const rows: string[] = [];
  let current = "";
  for (const hint of hints) {
    const candidate = current ? `${current}${HELP_HINT_SEPARATOR}${hint}` : hint;
    if (current && [...candidate].length > width) {
      rows.push(current);
      current = hint;
      continue;
    }
    current = candidate;
  }
  if (current) rows.push(current);
  return rows;
}

/**
 * Help body shared by both clients; previously each wrote its own summary.
 *
 * `width` keeps the notice inside the terminal: wide screens get aligned
 * usage/description columns, narrow ones stack the description under its
 * command instead of letting the notice renderer wrap mid-word.
 */
export function formatHelpNotice(commands: readonly CommandDef[] = SLASH_COMMANDS, width?: number): string {
  const listed = commands.filter((command) => !command.alias);
  const columnCap = commandUsageColumn(listed);
  // Notices are indented two columns, so that is the real text budget.
  const available = width === undefined ? Number.POSITIVE_INFINITY : Math.max(24, width - 2);
  const usageWidth = width === undefined ? columnCap : Math.max(16, Math.min(columnCap, Math.floor(available * 0.6)));
  // Rows that cannot keep both columns inside the budget stack the description
  // under the command instead of letting the notice renderer wrap mid-word. A
  // usage longer than the column still keeps a two-space gap
  // (`/copy [last|assistant|…]Copy a message …`).
  const rows = listed.flatMap((command) => {
    // Below the width of its own usage string a command falls back to the bare
    // `/name`, so the command column never wraps mid-token.
    const label = command.usage.length <= available ? command.usage : `/${command.name}`;
    const column = Math.max(usageWidth, label.length + 2);
    return column + command.description.length <= available
      ? [`${label.padEnd(column)}${command.description}`]
      : [label, `    ${command.description}`];
  });
  const hints = width === undefined
    ? [
      "Tab/↑↓ pick a command  ·  Enter run  ·  Esc close  ·  Shift+Tab permission mode",
      "Ctrl+R reasoning level  ·  Alt+T expand reasoning  ·  Alt+↑/↓ focus message",
      "Ctrl+Shift+T todo editor  ·  Ctrl+G jump to bottom  ·  PageUp/PageDown scroll",
    ]
    : packHints(HELP_KEYBIND_HINTS, Math.max(24, width - 2));
  return [...rows, "", ...hints].join("\n");
}
