/**
 * CLI argument parsing, split out of src/cli.ts. Pure, stateless functions
 * with no closure over the runtime — safe to test in isolation. `cli.ts`
 * re-exports these so existing imports (`../src/cli.ts`) keep working.
 */

import type { ToolName } from "../tools/index.ts";
import type { ForeignSessionSource } from "../foreign-session.ts";
import {
  isPermissionMode,
  removedApprovalModeMessage,
  type PermissionMode,
} from "../permissions.ts";
import { parseMcpAllowlist } from "../mcp/approval.ts";

export type ParsedCliArgs = {
  prompt: string;
  imagePaths: string[];
  tools?: ToolName[];
  excludeTools?: ToolName[];
  allowMcpTools: boolean;
  /** serverId or serverId/toolName entries from repeated --allow-mcp flags. */
  mcpAllowlist: string[];
  mode: PermissionMode;
  modeExplicit: boolean;
  planOnly: boolean;
  planExecute: boolean;
  planYes: boolean;
  planRetry: boolean;
  planForce: boolean;
  planShow: boolean;
  planApprove: boolean;
  planReject: boolean;
  planEdit: boolean;
  planSetFile?: string;
  planHistory: boolean;
  planArchive: boolean;
  sandboxEnabled: boolean;
  /** Explicit goal intent for this CLI invocation. */
  goal?: { objective?: string; clear?: boolean; status?: "pause" | "resume" | "complete"; tokenBudget?: number; background?: boolean };
  /** Resume the most recent session (Claude Code `--continue`). */
  continueSession: boolean;
  /** Resume a specific session id, or list sessions when no id is given. */
  resumeSessionId?: string;
  /** Import a Claude Code or Codex transcript. Empty string lists candidates. */
  foreignResume?: { source: ForeignSessionSource; reference: string };
  /** With --resume/--continue: start a new session seeded with old messages. */
  forkSession: boolean;
  /** Run the /init generator and exit without starting the agent loop. */
  init?: { force: boolean; print: boolean };
  /** Run the subagent worktree GC and exit without starting the agent loop. */
  gcWorktrees?: { dryRun: boolean };
};

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const imagePaths: string[] = [];
  const rest: string[] = [];
  let tools: ToolName[] | undefined;
  let excludeTools: ToolName[] | undefined;
  let allowMcpTools = false;
  const mcpAllowlist: string[] = [];
  let mode: PermissionMode = "plan";
  let modeExplicit = false;
  let planOnly = false;
  let planExecute = false;
  let planYes = false;
  let planRetry = false;
  let planForce = false;
  let planShow = false;
  let planApprove = false;
  let planReject = false;
  let planEdit = false;
  let planSetFile: string | undefined;
  let planHistory = false;
  let planArchive = false;
  let continueSession = false;
  let resumeSessionId: string | undefined;
  let foreignResume: ParsedCliArgs["foreignResume"];
  let forkSession = false;
  let sandboxEnabled = process.env.MINI_AGENT_SANDBOX !== "0";
  let init: ParsedCliArgs["init"] | undefined;
  let gcWorktrees: ParsedCliArgs["gcWorktrees"] | undefined;
  let goal: ParsedCliArgs["goal"];
  const validTools = new Set<ToolName>([
    "read", "bash", "edit", "write", "grep", "find", "ls",
    "bg_start", "bg_status", "bg_logs", "bg_send", "bg_wait", "bg_kill",
    "bg_snapshot", "bg_replay", "bg_search_logs", "bg_kill_by_tag", "bg_status_by_tag",
    "codebase_open", "codebase_search", "codebase_read", "codebase_explain",
    "web_search", "fetch_content", "get_search_content", "source_check",
    "subagent", "git_status", "git_diff", "git_checkpoint", "git_undo", "git_branch_isolate",
    "validate_workspace",
  ]);
  // NOTE: `request_permission_mode` is intentionally absent. The CLI has no
  // confirmation card, so it must not be selectable with `--tools`. The tool
  // list is also the source of truth for the system prompt (see
  // `toolProviderAdvertisesModeRequest` in loop.ts).
  const parseToolList = (value: string, flag: string): ToolName[] => {
    const names = value.split(",").map((name) => name.trim()).filter(Boolean);
    for (const name of names) {
      if (!validTools.has(name as ToolName)) throw new Error(`Unknown tool in ${flag}: ${name}`);
    }
    return names as ToolName[];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--goal" || arg.startsWith("--goal=")) {
      const raw = arg.startsWith("--goal=") ? arg.slice("--goal=".length) : (argv[i + 1] ?? "");
      if (!arg.startsWith("--goal=")) i += 1;
      const value = raw.trim();
      if (value.toLowerCase() === "clear") goal = { clear: true };
      else if (value.toLowerCase() === "pause" || value.toLowerCase() === "resume" || value.toLowerCase() === "complete") {
        goal = { status: value.toLowerCase() as "pause" | "resume" | "complete" };
      } else if (value) {
        // `--bg` / `--background` inside the objective opts into the detached
        // worktree worker; strip it so it never reaches the model prompt.
        const bgMatch = value.match(/(?:^|\s)--(?:bg|background)(?=\s|$)/i);
        const objective = bgMatch ? value.replace(bgMatch[0], " ").trim() : value;
        goal = { ...(objective ? { objective } : {}), ...(bgMatch ? { background: true } : {}) };
      }
      else goal = {};
      continue;
    }
    if (arg === "--goal-status") {
      goal = {};
      continue;
    }
    if (arg === "--goal-token-budget") {
      const value = Number(argv[i + 1]);
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("--goal-token-budget must be a positive integer");
      goal = { ...(goal ?? {}), tokenBudget: value };
      i += 1;
      continue;
    }
    if (arg === "--image") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--image requires a path argument");
      }
      imagePaths.push(next);
      i += 1;
      continue;
    }
    if (arg === "--allow-mcp-tools") {
      allowMcpTools = true;
      continue;
    }
    if (arg === "--allow-mcp" || arg.startsWith("--allow-mcp=")) {
      const value = arg === "--allow-mcp" ? argv[++i] : arg.slice("--allow-mcp=".length);
      if (!value || value.startsWith("--")) throw new Error("--allow-mcp requires serverId or serverId/toolName");
      mcpAllowlist.push(...parseMcpAllowlist(value));
      continue;
    }
    if (arg === "--plan") {
      planOnly = true;
      continue;
    }
    if (arg === "--plan-execute") {
      planExecute = true;
      continue;
    }
    if (arg === "--plan-retry") {
      planRetry = true;
      continue;
    }
    if (arg === "--plan-force") {
      planForce = true;
      continue;
    }
    if (arg === "--plan-show") {
      planShow = true;
      continue;
    }
    if (arg === "--plan-approve") {
      planApprove = true;
      continue;
    }
    if (arg === "--plan-reject") {
      planReject = true;
      continue;
    }
    if (arg === "--plan-edit") {
      planEdit = true;
      continue;
    }
    if (arg === "--plan-set-file") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--plan-set-file requires a path argument");
      }
      planSetFile = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("--plan-set-file=")) {
      const value = arg.slice("--plan-set-file=".length);
      if (!value) throw new Error("--plan-set-file= requires a path");
      planSetFile = value;
      continue;
    }
    if (arg === "--plan-history") {
      planHistory = true;
      continue;
    }
    if (arg === "--plan-archive") {
      planArchive = true;
      continue;
    }
    if (arg === "init") {
      init = { force: false, print: false };
      continue;
    }
    if (arg === "--init-force") {
      if (!init) init = { force: false, print: false };
      init.force = true;
      continue;
    }
    if (arg === "--init-print") {
      if (!init) init = { force: false, print: false };
      init.print = true;
      continue;
    }
    if (arg === "gc-worktrees") {
      gcWorktrees = { dryRun: false };
      continue;
    }
    if (arg === "--gc-dry-run") {
      if (!gcWorktrees) gcWorktrees = { dryRun: true };
      else gcWorktrees.dryRun = true;
      continue;
    }
    if (arg === "--yes") {
      planYes = true;
      continue;
    }
    if (arg === "--continue") {
      continueSession = true;
      continue;
    }
    if (arg === "--resume") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        // No id: list resumable sessions.
        resumeSessionId = "";
      } else {
        resumeSessionId = next;
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--resume=")) {
      resumeSessionId = arg.slice("--resume=".length);
      continue;
    }
    if (arg === "--resume-claude" || arg === "--resume-codex" || arg.startsWith("--resume-claude=") || arg.startsWith("--resume-codex=")) {
      const source: ForeignSessionSource = arg.startsWith("--resume-claude") ? "claude" : "codex";
      const inline = arg.indexOf("=");
      if (inline >= 0) {
        foreignResume = { source, reference: arg.slice(inline + 1) };
      } else {
        const next = argv[i + 1];
        foreignResume = !next || next.startsWith("--")
          ? { source, reference: "" }
          : { source, reference: next };
        if (next && !next.startsWith("--")) i += 1;
      }
      continue;
    }
    if (arg === "--fork-session") {
      forkSession = true;
      // Claude Code's fork flag is a resume operation that writes to a new
      // session. Make the flag useful on its own by selecting the latest one.
      continueSession = true;
      continue;
    }
    if (arg === "--mode") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--mode requires an argument: plan or bypass");
      }
      if (!isPermissionMode(next)) {
        throw new Error(next === "approval"
          ? removedApprovalModeMessage("Permission mode 'approval'")
          : "Invalid mode: use 'plan' or 'bypass'");
      }
      mode = next;
      modeExplicit = true;
      i += 1;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (!isPermissionMode(value)) {
        throw new Error(value === "approval"
          ? removedApprovalModeMessage("Permission mode 'approval'")
          : "Invalid mode: use 'plan' or 'bypass'");
      }
      mode = value;
      modeExplicit = true;
      continue;
    }
    if (arg.startsWith("--image=")) {
      const p = arg.slice("--image=".length);
      if (!p) throw new Error("--image= requires a path");
      imagePaths.push(p);
      continue;
    }
    if (arg === "--tools" || arg === "--exclude-tools") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) throw new Error(`${arg} requires a comma-separated tool list`);
      if (arg === "--tools") tools = parseToolList(next, arg);
      else excludeTools = parseToolList(next, arg);
      i += 1;
      continue;
    }
    if (arg.startsWith("--tools=") || arg.startsWith("--exclude-tools=")) {
      const isExclude = arg.startsWith("--exclude-tools=");
      const flag = isExclude ? "--exclude-tools" : "--tools";
      const value = arg.slice(flag.length + 1);
      if (!value) throw new Error(`${flag}= requires a comma-separated tool list`);
      if (isExclude) excludeTools = parseToolList(value, flag);
      else tools = parseToolList(value, flag);
      continue;
    }
    rest.push(arg);
  }

  return {
    prompt: rest.join(" ").trim(),
    imagePaths,
    tools,
    excludeTools,
    allowMcpTools,
    mcpAllowlist,
    mode,
    modeExplicit,
    planOnly,
    planExecute,
    planYes,
    planRetry,
    planForce,
    planShow,
    planApprove,
    planReject,
    planEdit,
    planSetFile,
    planHistory,
    planArchive,
    sandboxEnabled,
    continueSession,
    resumeSessionId,
    foreignResume,
    forkSession,
    init,
    gcWorktrees,
    goal,
  };
}

export function parseCliWorkerArgs(
  argv: string[],
  worker: { taskId?: string; batchJobId?: string; ownerSessionId?: string; mode?: PermissionMode; goalWorker?: boolean },
): ParsedCliArgs {
  if (!worker.taskId && !worker.batchJobId) return parseCliArgs(argv);
  if (!worker.ownerSessionId) throw new Error("Detached worker has no owning session ID.");
  // Goal workers start a fresh session in their worktree (the owner session
  // lives in the live checkout's workspace and is not resumable here); the
  // goal store binding happens via MINI_AGENT_GOAL_WORKER_OWNER instead.
  if (worker.goalWorker) return parseCliArgs(["--mode", worker.mode ?? "bypass"]);
  return parseCliArgs(["--resume", worker.ownerSessionId, "--mode", worker.mode ?? "plan"]);
}
