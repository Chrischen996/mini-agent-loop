// tui-core — optional renderer-agnostic CommandRegistry execution bodies.
//
// Each body receives parsed command arguments and a CommandContext, and
// returns true when handled locally. The Ink UI keeps overlay-specific
// command routing in App.tsx; the shared command catalog stays in
// slash-commands.ts.

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
    case "resume":
      return { cmd: "resume", raw: parsed.raw ?? "" };
    default:
      return { cmd: parsed.cmd, raw: text };
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
      ctx.store.dispatch({ type: "SET_TODOS", todos: result.todos });
      // The headless context carries persistence through an optional hook.
      ctx.persistTodoState?.(result.todos);
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
    // args may have structured fields (from parseArgs) or raw text
    // (from dispatch which re-parses and drops structured fields).
    const raw = ((args as { raw?: string }).raw ?? "").trim();
    const direct: {
      cmd: "read" | "bash" | "ls" | "find" | "grep";
      path?: string;
      command?: string;
      pattern?: string;
    } | null = (() => {
      switch (args.cmd) {
        case "read": return { cmd: "read", path: (args as { path?: string }).path ?? raw.slice(6).trim() };
        case "bash": return { cmd: "bash", command: (args as { command?: string }).command ?? raw.slice(6).trim() };
        case "ls": return { cmd: "ls", path: (args as { path?: string }).path ?? "." };
        case "find": return { cmd: "find", pattern: (args as { pattern?: string }).pattern ?? "*", path: (args as { path?: string }).path ?? "." };
        case "grep": return { cmd: "grep", pattern: (args as { pattern?: string }).pattern ?? "", path: (args as { path?: string }).path ?? "." };
        default: return null;
      }
    })();
    if (!direct) return false;

    const directArgs: Record<string, unknown> =
      direct.cmd === "read" ? { path: direct.path! }
      : direct.cmd === "bash" ? { command: direct.command! }
      : direct.cmd === "ls" ? { path: direct.path! }
      : direct.cmd === "find" ? { pattern: direct.pattern!, path: direct.path! }
      : { pattern: direct.pattern!, path: direct.path! };

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
 * current runtime. The Ink UI owns its full session restore path; this
 * headless seed leaves model/skill rebinds to the caller.
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
    // Load the target; the caller still owns model and todo restoration.
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
 * caller passes its parser's result; unknown commands fall back to a generic
 * `{ cmd: name, raw }` shape when no dedicated parser arm exists.
 */
export function parseArgs(parsed: SlashCommand, text: string): ParsedCommandArgs {
  return argsFor(parsed, text);
}

// ─── /todos run --parallel helpers ──────────────────────────────────────────

import {
  parseTodosRunArgs,
  buildRunnerDag,
  formatDryRun,
  runTodoPlan,
  mergeOutcomesIntoTodos,
  formatOutcome,
  summarizeOutcomes,
  type ParsedTodosRunArgs,
  type RunnerPlan,
} from "../../todos/index.ts";
import type { BgTaskManager } from "../../bg-tasks/manager.js";
import type { SubagentToolsFactoryDeps } from "../subagent-tools-factory.ts";
import { parseSubagentReceipt, type SubagentTaskCommand, type BgTaskCommand } from "../../todos/execute.ts";

export type TodosRunExecutors = {
  subagent: (plan: SubagentTaskCommand, signal?: AbortSignal) => Promise<{ ok: boolean; summary?: string; error?: string }>;
  startBgTask: (plan: BgTaskCommand) => Promise<string>;
  pollBgTask: (taskId: string, signal?: AbortSignal) => Promise<{ ok: boolean; done: boolean; summary?: string; error?: string }>;
};

export function todosRunExecutors(options: {
  getBgManager: () => BgTaskManager | null;
  subagentFactory: SubagentToolsFactoryDeps & { getTools: (deps: SubagentToolsFactoryDeps) => import("../../tools/types.ts").Tool[] };
  getSubagentTools?: () => import("../../tools/types.ts").Tool[];
}): TodosRunExecutors {
  const manager = options.getBgManager();
  const startBgTask = async (plan: BgTaskCommand) => {
    if (!manager) throw new Error("Background tasks are not available in this session");
    const started = await manager.start({
      command: plan.command,
      ...(plan.timeoutSeconds ? { timeoutSeconds: plan.timeoutSeconds } : {}),
      ...(plan.tags ? { tags: plan.tags } : {}),
    });
    return started.taskId;
  };
  const pollBgTask = async (taskId: string, signal?: AbortSignal) => {
    if (!manager) return { ok: false, done: true, error: "Background tasks are not available" };
    const result = await manager.wait([taskId], "all", signal ? 30 : 300);
    const summary = await manager.get(taskId);
    if (!summary) return { ok: false, done: true, error: "Background task not found" };
    const ok = summary.status === "completed" && (summary.exitCode ?? 0) === 0;
    return {
      ok,
      done: true,
      summary: summary.status,
      error: ok ? undefined : summary.reason ?? `background task ended with status ${summary.status}`,
    };
  };
  const subagent = async (plan: SubagentTaskCommand, signal?: AbortSignal) => {
    const tools = options.getSubagentTools?.() ?? [];
    const subagentTool = tools.find((t) => t.name === "subagent");
    if (!subagentTool) throw new Error("subagent tool is not available");
    const result = await subagentTool.execute({
      task: plan.task,
      profile: plan.profile ?? "coder",
      ...(plan.model ? { model: plan.model } : {}),
    } as never, signal);
    const content = typeof result.content === "string"
      ? result.content
      : result.content.map((part) => part.type === "text" || part.type === "vision_analysis" ? part.text : "").join("\n");
    const receipt = parseSubagentReceipt(content);
    return {
      ...receipt,
      summary: receipt.summary ?? content.slice(0, 500),
    };
  };
  return { subagent, startBgTask, pollBgTask };
}

export const runTodos: (ctx: import("./commands.ts").TodosRunCommandContext, args: import("./commands.ts").ParsedCommandArgs) => Promise<boolean> =
  async (ctx, args) => {
    if (args.cmd !== "todos-run") return false;
    const parsed = (args as { args?: ParsedTodosRunArgs }).args as ParsedTodosRunArgs;
    const todos = ctx.todoRunConfirmed && ctx.todoRunSnapshot
      ? ctx.todoRunSnapshot.map((todo) => ({ ...todo }))
      : ctx.store.getState().todoItems ?? [];
    const plan = buildRunnerDag(todos, parsed);
    if (plan.errors.length > 0) {
      ctx.store.dispatch({ type: "ADD_NOTICE", title: "Todo runner", text: plan.errors.join("\n") });
      return true;
    }
    if (parsed.dryRun) {
      ctx.store.dispatch({
        type: "ADD_NOTICE",
        title: "Todo runner dry-run",
        text: formatDryRun(plan),
      });
      return true;
    }
    // Always stage a plan first. --yes is deliberately not a bypass for this
    // interactive UI; the user must review the exact plan and confirm in TUI.
    if (!ctx.todoRunConfirmed) {
      ctx.onConfirmTodoRun?.({ plan, parsed, todos: todos.map((todo) => ({ ...todo })) });
      ctx.store.dispatch({
        type: "ADD_NOTICE",
        title: "Todo runner",
        text: "Review the run plan below. Press A/Enter to execute, or Esc/D to cancel.",
      });
      return true;
    }
    if (parsed.worktree) {
      ctx.store.dispatch({
        type: "ADD_NOTICE",
        title: "Todo runner",
        text: "--worktree is not available in this runtime yet; execution was blocked to avoid silently using the shared checkout.",
      });
      return true;
    }
    const executors = ctx.todosRunExecutors;
    if (!executors) {
      ctx.store.dispatch({
        type: "ADD_NOTICE",
        title: "Todo runner",
        text: "No executors registered; re-run the command in a TUI session with subagent and background task support.",
      });
      return true;
    }
    const outcomes = await runTodoPlan(plan, {
      subagent: executors.subagent,
      startBgTask: executors.startBgTask,
      pollBgTask: executors.pollBgTask,
      maxConcurrency: parsed.maxConcurrency ?? 2,
      onEvent: () => undefined,
    });
    const merged = mergeOutcomesIntoTodos(todos, outcomes);
    ctx.store.dispatch({ type: "SET_TODO_ITEMS", todos: merged.todos, revision: merged.revision });
    ctx.persistTodoState?.(merged.todos);
    ctx.store.dispatch({
      type: "ADD_NOTICE",
      title: "Todo runner",
      text: summarizeOutcomes(plan, outcomes),
    });
    return true;
  };
