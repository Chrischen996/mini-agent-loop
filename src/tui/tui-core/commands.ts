// tui-core — SlashCommand registry (P2).
//
// The registry is the single source of truth for what a typed `/name`
// resolves to. Each entry is a `CommandDef` with an optional `run(ctx,
// args)` body. The pi-tui entrypoint (terminal-main.ts) and the Ink
// entrypoint (App.tsx) both pull their command handling from this
// registry, so a new command is added in one place and both clients
// pick it up.
//
// The current `slash-commands.ts` catalog (name/usage/description) is
// re-exported as the "static metadata" surface: palette + `/help` +
// unknown-command guard. The P2 `CommandRegistry` layers execution on
// top of that catalog.

import type { SlashCommand } from "../slash-commands.ts";
import type { TuiStore } from "../state.ts";
import type { PermissionManager } from "../../permissions.ts";
import type { ToolProvider } from "../../tools/types.ts";
import type { LegacyTodoCommand } from "../todo-commands.ts";

export type CommandContext = {
  store: TuiStore;
  sessionRef: { current: string };
  permissionManager: PermissionManager;
  cwd: string;
  allTools: ToolProvider;
  /** Record a typed command into input history. */
  recordSubmission: (text: string) => void;
  /** Clear the input line after a command runs. */
  clearInput: () => void;
  /** Abort the in-flight direct-tool call on Ctrl+C / Esc. */
  abortSignal?: AbortSignal;
};

export type ParsedCommandArgs =
  | { cmd: "read"; path: string }
  | { cmd: "bash"; command: string }
  | { cmd: "ls"; path: string }
  | { cmd: "find"; pattern: string; path: string }
  | { cmd: "grep"; pattern: string; path: string }
  | { cmd: "todo"; todo: LegacyTodoCommand }
  | { cmd: string; raw: string };

export type CommandDef = {
  /** Bare command name without the leading slash. */
  name: string;
  /** Usage line shown in `/help` and the `/` palette. */
  usage: string;
  /** Short human description. */
  description: string;
  /**
   * When true, the command shows a confirmation row in the palette
   * before running (e.g. `/clear`, `/exit`).
   */
  confirm?: boolean;
  /**
   * Execution body. Must be renderer-agnostic: no React, no Ink, no
   * pi-tui. Receives the command context + parsed args. Returns `true`
   * when the command was handled entirely locally (no agent turn),
   * `false` when the command should fall through to the agent.
   */
  run?: (ctx: CommandContext, args: ParsedCommandArgs) => boolean | Promise<boolean>;
};

export type CommandRegistry = {
  /** All registered commands (metadata + execution). */
  defs: readonly CommandDef[];
  /** Resolve a typed command line to its parsed form, or null for unknowns. */
  resolve(input: string): SlashCommand | null;
  /** `/help` body: aligned usage + description rows. */
  help(width?: number): string;
  /**
   * Dispatch a typed command line through its `run` body. Returns true
   * when the command was handled locally (no agent turn); false when
   * it fell through to the agent.
   */
  dispatch(input: string, ctx: CommandContext): Promise<boolean>;
};

import {
  SLASH_COMMANDS,
  KNOWN_SLASH_COMMAND_NAMES,
  parseSlashCommand,
  parseUnknownSlashCommand,
  formatHelpNotice,
  commandUsageColumn,
  type CommandDef as LegacyCommandDef,
} from "../slash-commands.ts";

export {
  SLASH_COMMANDS,
  KNOWN_SLASH_COMMAND_NAMES,
  parseSlashCommand,
  parseUnknownSlashCommand,
  formatHelpNotice,
  commandUsageColumn,
};
export type { SlashCommand };
export type { LegacyCommandDef };

/**
 * Build a P2 command registry from the existing static catalog + an
 * execution map. The execution map is keyed by command name; a name
 * without a `run` entry falls through to the agent (returns false).
 */
export function createCommandRegistry(
  execution: Partial<Record<string, CommandDef["run"]>>,
  defs: readonly CommandDef[] = SLASH_COMMANDS.map((entry) => ({
    name: entry.name,
    usage: entry.usage,
    description: entry.description,
  })),
): CommandRegistry {
  const merged: CommandDef[] = defs.map((def) => {
    const run = execution[def.name];
    return run ? { ...def, run } : def;
  });

  return {
    defs: merged,
    resolve: (input) => parseSlashCommand(input),
    help: (width?: number) => formatHelpNotice(SLASH_COMMANDS, width),
    async dispatch(input, ctx): Promise<boolean> {
      const parsed = parseSlashCommand(input);
      if (!parsed) {
        // Not a known slash command; the caller decides whether to
        // treat it as an agent prompt or an unknown-command notice.
        return false;
      }
      const def = merged.find((command) => command.name === parsed.cmd);
      if (!def?.run) return false;
      ctx.recordSubmission(input);
      ctx.clearInput();
      const args: ParsedCommandArgs =
        parsed.cmd === "todo"
          ? { cmd: "todo", todo: parsed.todo }
          : { cmd: parsed.cmd, raw: input };
      return await def.run(ctx, args);
    },
  };
}
