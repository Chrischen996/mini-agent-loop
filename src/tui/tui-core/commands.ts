// tui-core — SlashCommand registry (P1 seed).
//
// The registry is the single source of truth for what a typed `/name`
// resolves to. Currently it re-exports the existing `slash-commands.ts`
// catalog (name/usage/description) and its `SlashCommand` parse type so
// both entrypoints share one parse + help surface.
//
// P2 will grow this file into `{ name, usage, category, args, confirm?,
// run(ctx) }` and add the completion engine + `/` menu derivation. Until
// then the registry is a thin re-export and the freeze rule is: no new
// command may add an `if (text === "/x")` branch to App.tsx or
// terminal-main.ts.

import type { SlashCommand } from "../slash-commands.ts";

export type CommandContext = {
  store: import("../state.ts").TuiStore;
  sessionRef: { current: string };
  permissionManager: import("../../permissions.ts").PermissionManager;
  cwd: string;
  allTools: import("../../tools/types.ts").ToolProvider;
};

export type CommandDef = {
  /** Bare command name without the leading slash. */
  name: string;
  /** Usage line shown in `/help` and the `/` palette. */
  usage: string;
  /** Short human description. */
  description: string;
  /**
   * Optional argument parser. When omitted, the command takes no arguments
   * and `run` receives an empty args object.
   */
  parseArgs?: (raw: string) => unknown;
  /**
   * When true, the command shows a confirmation row in the palette before
   * running (e.g. `/clear`, `/exit`).
   */
  confirm?: boolean;
  /**
   * Execution body. Must be renderer-agnostic: no React, no Ink, no
   * pi-tui. Receives the command context + parsed args, returns either a
   * `SlashCommand` parse result (for direct-tool commands) or `null` when
   * the command was handled entirely locally.
   */
  run?: (ctx: CommandContext, args: unknown) => SlashCommand | null | Promise<SlashCommand | null>;
};

export type CommandRegistry = {
  defs: readonly CommandDef[];
  /** Resolve a typed command line to its parsed form, or null for unknowns. */
  resolve(input: string): SlashCommand | null;
  /** `/help` body: aligned usage + description rows. */
  help(width?: number): string;
};

// The registry seeds from the existing catalog. P2 replaces the re-export
// with a concrete `{ name, usage, category, args, run }` table and wires
// each entry's `run` to the shared handlers currently in terminal-main.ts /
// App.tsx.
export function createCommandRegistry(
  defs: readonly CommandDef[],
  options: {
    resolve: (input: string) => SlashCommand | null;
    help: (width?: number) => string;
  },
): CommandRegistry {
  return {
    defs,
    resolve: options.resolve,
    help: options.help,
  };
}

export {
  SLASH_COMMANDS,
  KNOWN_SLASH_COMMAND_NAMES,
  parseSlashCommand,
  parseUnknownSlashCommand,
  formatHelpNotice,
  commandUsageColumn,
  COMMAND_USAGE_COLUMN_MAX,
  HELP_KEYBIND_HINTS,
  PATH_COMMANDS,
  ARGUMENT_COMMANDS,
  type CommandDef as LegacyCommandDef,
} from "../slash-commands.ts";

export type { SlashCommand };
