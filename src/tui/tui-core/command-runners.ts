// tui-core — CommandRegistry execution entries (P4-follow-up).
//
// This is the first batch of `run` bodies that move off the inline
// `if (slashCommand?.cmd === …)` chains in terminal-main.ts and
// App.tsx. Each entry is renderer-agnostic: it receives the parsed
// command args + a `CommandContext`, and returns `true` when the
// command was fully handled locally, `false` when it should fall
// through to the agent.
//
// The pi-tui entry (terminal-main.ts) still keeps a small number of
// terminal-specific branches (multi-agent wizard, /init wizard, session
// resume) inline — those carry UI state that has not yet been lifted
// into the kernel, and move here one by one as their state gets
// relocated to slices.

import type { SlashCommand } from "../slash-commands.ts";
import type { CommandContext, ParsedCommandArgs } from "./commands.ts";
import { runDirectTool } from "../direct-tool-runner.ts";
import { applyTodoCommand, type LegacyTodoCommand } from "../todo-commands.ts";
import { parseResumeCommand } from "../session-serialization.ts";
import { formatAmbiguousSessionNotice, resolveSessionByPrefix } from "../session-serialization.ts";
import type { PersistedSession, PersistedSessionMeta } from "../../session-store.ts";

/**
 * Build a ParsedCommandArgs for a direct-tool slash command from the
 * raw parsed slash form. The raw `text` is the typed line (with the
 * leading slash); it is passed through so a command can recover
 * arguments that the narrow parser dropped.
 */
function argsFor(parsed: SlashCommand, text: string): ParsedCommandArgs {
  if (!parsed) return { cmd: "unknown", raw: text };
  switch (parsed.cmd) {
    case "todo":
      return { cmd: "todo", todo: parsed.todo };
    case "read":
      return { cmd: "read", path: parsed.path };
    case "bash":
      return { cmd: "bash", command: parsed.command };
    case "ls":
      return { cmd: "ls", path: parsed.path };
    case "find":
      return { cmd: "find", pattern: parsed.pattern, path: parsed.path };
    case "grep":
      return { cmd: "grep", pattern: parsed.pattern, path: parsed.path };
  }
}

/**
 * `/todo …` — manual todo edits stay in local session state; do not
 * spend an agent turn. Applies the command to the current todo list
 * and dispatches the new state (or an error notice).
 */
export const runTodo: (ctx: CommandContext, args: ParsedCommandArgs) => Promise<boolean> =
  async (ctx, args) => {
    const todoCmd = args as { cmd: "todo"; todo: LegacyTodoCommand };
    ctx.recordSubmission("/todo");
    ctx.clearInput();
    const current = ctx.store.getState().todoItems ?? [];
    const result = applyTodoCommand(current, todoCmd.todo);
    if (result.ok) {
      ctx.store.dispatch({ type: "SET_TODOS", todos: result.todos });      // persistTodoState is a terminal-main extension; the kernel-level
      // context carries it through an optional hook.
      (ctx as unknown as { persistTodoState?: (t: import("../../todo.ts").TodoItem[]) => void }).persistTodoState?.(result.todos);
    } else {
      ctx.store.dispatch({ type: "ADD_NOTICE", title: "Todo", text: result.error });
    }
    return true;
  };

/**
 * `/read …` / `/bash …` / `/ls …` / `/find …` / `/grep …` — the
 * direct-tool slash commands. Runs the tool once, records the turn on
 * the agent history, and dispatches a `done` loop event so the
 * transcript shows the exchange without spending a model call.
 */
export const runDirectToolCommand: (ctx: CommandContext, args: ParsedCommandArgs) => Promise<boolean> =
  async (ctx, args) => {
    // Only the five direct-tool commands are handled here; anything
    // else falls through to the agent.
    const direct = (():
      | { cmd: "read"; path: string }
      | { cmd: "bash"; command: string }
      | { cmd: "ls"; path: string }
      | { cmd: "find"; pattern: string; path: string }
      | { cmd: "grep"; pattern: string; path: string }
      | undefined => {
      switch (args.cmd) {
        case "read": return args as { cmd: "read"; path: string };
        case "bash": return args as { cmd: "bash"; command: string };
        case "ls": return args as { cmd: "ls"; path: string };
        case "find": return args as { cmd: "find"; pattern: string; path: string };
        case "grep": return args as { cmd: "grep"; pattern: string; path: string };
        default: return undefined;
      }
    })();
    if (!direct) return false;

    const directArgs: Record<string, unknown> =
      direct.cmd === "read" ? { path: direct.path }
      : direct.cmd === "bash" ? { command: direct.command }
      : direct.cmd === "ls" ? { path: direct.path }
      : direct.cmd === "find" ? { pattern: direct.pattern, path: direct.path }
      : { pattern: direct.pattern, path: direct.path };

    const rawText =
      direct.cmd === "read" ? ` /read ${direct.path}`
      : direct.cmd === "bash" ? ` /bash ${direct.command}`
      : direct.cmd === "ls" ? ` /ls ${direct.path}`
      : direct.cmd === "find" ? ` /find ${direct.pattern} ${direct.path}`
      : ` /grep ${direct.pattern} ${direct.path}`;
    ctx.recordSubmission(rawText.trim());
    ctx.clearInput();
    ctx.store.dispatch({ type: "USER_MESSAGE", text: rawText.trim() });

    const abortController = new AbortController();
    const deps = ctx as unknown as {
      directAbortRef?: { current?: AbortController };
      service?: { recordDirectToolTurn: (p: string, c: unknown, r: unknown) => Promise<unknown> };
    };
    if (deps.directAbortRef) deps.directAbortRef.current = abortController;
    try {
      const directResult = await runDirectTool(direct.cmd, directArgs, {
        allTools: ctx.allTools,
        permissionSessionId: ctx.sessionRef.current,
        getPermissionManager: () => ctx.permissionManager,
        abortSignal: abortController.signal,
        dispatch: ctx.store.dispatch,
      });
      if (deps.service) await deps.service.recordDirectToolTurn(rawText.trim(), directResult.call, directResult.result);
    } finally {
      if (deps.directAbortRef?.current === abortController) deps.directAbortRef.current = undefined;
    }
    return true;
  };

/**
 * `/resume …` — list saved sessions, resolve a prefix, and either
 * surface an ambiguous notice or load the target session into the
 * current runtime. This is a seed entry: the full restore path (model
 * switch, skill rebind, history rewrite) is still terminal-main
 * specific and stays inline until P4-follow-up converges App.tsx.
 */
export const runResume: (ctx: CommandContext, args: ParsedCommandArgs) => Promise<boolean> =
  async (ctx, args) => {
    const generic = "cmd" in args && (args as { cmd: string }).cmd === "resume"
      ? "raw" in args ? (args as { raw: string }).raw : ""
      : "raw" in args ? (args as { raw: string }).raw : "";
    const parsed = parseResumeCommand(generic);
    if (!parsed) return false;
    ctx.recordSubmission(generic);
    ctx.clearInput();

    const sessionAccess = (ctx as unknown as { sessionAccess?: {
      list: () => Promise<PersistedSessionMeta[]>;
      load: (id: string) => Promise<PersistedSession | undefined>;
    } }).sessionAccess;
    if (!sessionAccess) return false;

    const sessions = await sessionAccess.list().catch(() => [] as PersistedSessionMeta[]);
    const selection = resolveSessionByPrefix(sessions, parsed.prefix);
    if (!selection.session && selection.candidates.length > 1) {
      ctx.store.dispatch({
        type: "ADD_NOTICE",
        title: "Resume session",
        text: formatAmbiguousSessionNotice(parsed.prefix, selection.candidates),
      });
      return true;
    }
    const target = selection.session;
    if (!target) {
      ctx.store.dispatch({
        type: "ADD_NOTICE",
        title: "Resume session",
        text: parsed.prefix ? `No session found: ${parsed.prefix}` : "No saved sessions.",
      });
      return true;
    }
    // Load the target; the rest of the restore (model switch, todo
    // rewrite) is entrypoint-specific and stays in terminal-main.ts
    // until P4-follow-up.
    const restored = await sessionAccess.load(target.id);
    if (!restored) {
      ctx.store.dispatch({
        type: "ADD_NOTICE",
        title: "Resume session",
        text: `Unable to read session: ${target.id}`,
      });
      return true;
    }
    ctx.sessionRef.current = target.id;
    ctx.store.dispatch({ type: "RESTORE_SESSION", history: [], permissionMode: "plan" });
    return true;
  };

/**
 * Convenience: build the ParsedCommandArgs for a raw typed line. The
 * entrypoint passes its own parser's result; this mirrors the
 * terminal-main.ts behavior of falling back to a generic
 * `{ cmd: name, raw }` shape for commands without a dedicated parser
 * arm.
 */
export function parseArgs(parsed: SlashCommand, text: string): ParsedCommandArgs {
  return argsFor(parsed, text);
}
