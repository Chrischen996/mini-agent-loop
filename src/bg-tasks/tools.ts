import type { Tool, JsonSchema } from "../tools/types.ts";
import type { BgTaskManager, SendTaskInput } from "./manager.js";

export function createBgTaskTools(manager: BgTaskManager): Tool[] {
  return [
    {
      name: "bg_start",
      description:
        "Start a shell command in a persistent background task and return immediately with its task ID. Uses tmux when available and a detached process fallback otherwise.",
      displayName: "Background Task",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run (mutually exclusive with template)" },
          template: { type: "string", description: "Named template from .bg-tasks/templates.json to expand into a command" },
          name: { type: "string", description: "Optional task name (defaults to command prefix)" },
          cwd: { type: "string", description: "Working directory (absolute or relative to project cwd)" },
          timeoutSeconds: { type: "integer", minimum: 1, maximum: 604_800, description: "Optional timeout in seconds" },
          tags: { type: "array", items: { type: "string" }, description: "Labels for grouping, e.g. ['build', 'integration']" },
          dependsOn: { type: "array", items: { type: "string" }, description: "Task IDs that must complete before this task starts" },
          strategy: { type: "string", enum: ["all", "any"], description: "Wait strategy for dependsOn" },
          priority: { type: "string", enum: ["high", "normal", "low"], description: "Scheduling priority (informational)" },
        },
        required: [],
        additionalProperties: false,
      } as JsonSchema,
      execute: async (args, signal) => {
        if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
        if (!args.command && !args.template) throw new Error("Either command or template is required");
        const task = await manager.start({
          command: args.command !== undefined ? String(args.command) : undefined,
          template: args.template !== undefined ? String(args.template) : undefined,
          name: args.name !== undefined ? String(args.name) : undefined,
          cwd: args.cwd !== undefined ? String(args.cwd) : undefined,
          timeoutSeconds: args.timeoutSeconds !== undefined ? Number(args.timeoutSeconds) : undefined,
          tags: args.tags !== undefined ? (args.tags as unknown[]).map((x) => String(x)) : undefined,
          depends_on: args.dependsOn !== undefined ? (args.dependsOn as unknown[]).map((x) => String(x)) : undefined,
          strategy: args.strategy === "any" ? "any" : "all",
          priority: args.priority !== undefined ? String(args.priority) as "high" | "normal" | "low" : undefined,
        });
        return { content: `Started ${task.taskId} (${task.name}); status: ${task.status}.` };
      },
    },
    {
      name: "bg_status",
      description: "Inspect status, runtime, exit code, and log path for background tasks.",
      displayName: "Task Status",
      parameters: {
        type: "object",
        properties: {
          taskIds: { type: "array", items: { type: "string" }, maxItems: 50, description: "Task IDs to inspect (omit for all current tasks)" },
        },
        additionalProperties: false,
      } as JsonSchema,
      execute: async (args, signal) => {
        if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
        const ids = Array.isArray(args.taskIds) ? (args.taskIds as unknown[]).map((id) => String(id)) : [];
        const tasks =
          ids.length > 0
            ? await Promise.all(ids.map((id) => manager.get(id))).then((results) => results.filter((t) => t !== undefined))
            : await manager.list();
        const lines = tasks.map((task) => {
          const runtime = task.durationMs !== undefined ? ` · ${Math.round(task.durationMs / 1000)}s` : "";
          const exit =
            task.exitCode === 0 || task.exitCode === null || task.exitCode === undefined
              ? ""
              : ` · exit ${task.exitCode}`;
          return `${task.status.padEnd(11)} ${task.taskId}  ${task.name}${runtime}${exit}`;
        });
        return { content: lines.join("\n") || "No tasks." };
      },
    },
    {
      name: "bg_logs",
      description: "Read a bounded byte range from a task log, or capture the current live terminal screen.",
      displayName: "Task Logs",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          source: { type: "string", enum: ["log", "screen"], default: "log" },
          offset: { type: "integer", minimum: 0 },
          limitBytes: { type: "integer", minimum: 4, maximum: 65_536 },
          screenLines: { type: "integer", minimum: 1, maximum: 500 },
        },
        required: ["taskId"],
        additionalProperties: false,
      } as JsonSchema,
      execute: async (args, signal) => {
        if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
        const taskId = String(args.taskId);
        const source = args.source === "screen" ? "screen" : "log";
        const chunk =
          source === "screen"
            ? await manager.screen(taskId, args.screenLines !== undefined ? Number(args.screenLines) : 200)
            : await manager.logs(
                taskId,
                args.offset !== undefined ? Number(args.offset) : 0,
                args.limitBytes !== undefined ? Number(args.limitBytes) : 16_384,
              );
        const text =
          source === "log"
            ? `${chunk.text}\n\n[offset ${chunk.offset} → ${chunk.nextOffset}; endOfLog=${chunk.endOfLog}]`
            : chunk.text;
        return { content: text };
      },
    },
    {
      name: "bg_send",
      description: "Send literal text, Enter, or a control key (ctrl_c, ctrl_d, ctrl_z, up, down, left, right) to a running tmux-backed background task. Process-backed tasks do not support interactive input.",
      displayName: "Task Input",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          text: { type: "string" },
          enter: { type: "boolean" },
          key: { type: "string", enum: ["ctrl_c", "ctrl_d", "ctrl_z", "up", "down", "left", "right"] },
        },
        required: ["taskId"],
        additionalProperties: false,
      } as JsonSchema,
      execute: async (args, signal) => {
        if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
        const task = await manager.send(String(args.taskId), {
          text: args.text !== undefined ? String(args.text) : undefined,
          enter: args.enter === true,
          key: args.key !== undefined ? String(args.key) as SendTaskInput["key"] : undefined,
        });
        return { content: `Input sent to ${task.taskId}` };
      },
    },
    {
      name: "bg_wait",
      description: "Wait inside one tool call until any or all selected tasks finish, without repeated LLM polling.",
      displayName: "Wait for Tasks",
      parameters: {
        type: "object",
        properties: {
          taskIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 },
          mode: { type: "string", enum: ["any", "all"], default: "all" },
          timeoutSeconds: { type: "integer", minimum: 1, maximum: 86_400 },
        },
        required: ["taskIds"],
        additionalProperties: false,
      } as JsonSchema,
      execute: async (args, signal) => {
        if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
        const ids = (args.taskIds as unknown[]).map((id) => String(id));
        const mode = args.mode === "any" ? "any" : "all";
        const timeoutSeconds = args.timeoutSeconds !== undefined ? Number(args.timeoutSeconds) : undefined;
        const result = await manager.wait(ids, mode, timeoutSeconds, signal);
        const lines = result.completed.map((task) => {
          const exit =
            task.exitCode === 0 || task.exitCode === null || task.exitCode === undefined
              ? ""
              : `, exit ${task.exitCode}`;
          return `${task.taskId}: ${task.status}${exit}`;
        });
        if (result.pending.length > 0) lines.push(`Pending: ${result.pending.join(", ")}`);
        if (result.timedOut) lines.push("Wait timed out; pending tasks are still running.");
        return { content: lines.join("\n") || "No task state changed." };
      },
    },
    {
      name: "bg_kill",
      description: "Gracefully cancel a running background task, or force-stop its tmux session/process group.",
      displayName: "Stop Task",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          force: { type: "boolean", default: false },
        },
        required: ["taskId"],
        additionalProperties: false,
      } as JsonSchema,
      execute: async (args, signal) => {
        if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
        const task = await manager.terminate(String(args.taskId), args.force === true);
        return { content: `${task.taskId} is ${task.status}.` };
      },
    },
    {
      name: "bg_snapshot",
      description: "Save a task snapshot (command, cwd, exit code, status, tags) to .bg-tasks/instances/<id>/snapshots/.",
      displayName: "Snapshot Task",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          include: { type: "array", items: { type: "string" } },
        },
        required: ["taskId"],
        additionalProperties: false,
      } as JsonSchema,
      execute: async (args, signal) => {
        if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
        const result = await manager.snapshot({
          taskId: String(args.taskId),
          include: args.include !== undefined ? (args.include as unknown[]).map((x) => String(x)) : undefined,
        });
        return { content: `Snapshot saved to ${result.snapshotPath}` };
      },
    },
    {
      name: "bg_replay",
      description: "Restore and restart a task from a previously saved snapshot file.",
      displayName: "Replay Task",
      parameters: {
        type: "object",
        properties: {
          snapshot: { type: "string" },
        },
        required: ["snapshot"],
        additionalProperties: false,
      } as JsonSchema,
      execute: async (args, signal) => {
        if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
        const task = await manager.replay({ snapshot: String(args.snapshot) });
        return { content: `Replayed as ${task.taskId} (${task.name}); status: ${task.status}.` };
      },
    },
    {
      name: "bg_search_logs",
      description: "Search a task log by keyword or log level, with optional context lines and reverse ordering.",
      displayName: "Search Logs",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          search: { type: "string" },
          context: { type: "integer", minimum: 0, maximum: 50 },
          level: { type: "string", enum: ["debug", "info", "warn", "error"] },
          reverse: { type: "boolean" },
        },
        required: ["taskId"],
        additionalProperties: false,
      } as JsonSchema,
      execute: async (args, signal) => {
        if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
        const result = await manager.searchLogs(String(args.taskId), {
          search: args.search !== undefined ? String(args.search) : undefined,
          context: args.context !== undefined ? Number(args.context) : undefined,
          level: args.level !== undefined ? String(args.level) as "debug" | "info" | "warn" | "error" : undefined,
          reverse: args.reverse === true,
        });
        return { content: result.matchCount > 0 ? `${result.matchCount} match(es):\n${result.matches.join("\n---\n")}` : "No matches." };
      },
    },
    {
      name: "bg_kill_by_tag",
      description: "Terminate all running tasks that carry the given tag.",
      displayName: "Kill Tasks by Tag",
      parameters: {
        type: "object",
        properties: {
          tag: { type: "string" },
        },
        required: ["tag"],
        additionalProperties: false,
      } as JsonSchema,
      execute: async (args, signal) => {
        if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
        const tag = String(args.tag);
        const tasks = await manager.list();
        const targets = tasks.filter((t) => t.tags?.includes(tag));
        await Promise.all(targets.map((t) => manager.terminate(t.taskId)));
        return { content: `Killed ${targets.length} task(s) with tag "${tag}".` };
      },
    },
    {
      name: "bg_status_by_tag",
      description: "List status of all tasks that carry the given tag.",
      displayName: "Status by Tag",
      parameters: {
        type: "object",
        properties: {
          tag: { type: "string" },
        },
        required: ["tag"],
        additionalProperties: false,
      } as JsonSchema,
      execute: async (args, signal) => {
        if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
        const tag = String(args.tag);
        const tasks = (await manager.list()).filter((t) => t.tags?.includes(tag));
        const lines = tasks.map((t) => `${t.status.padEnd(11)} ${t.taskId}  ${t.name}`);
        return { content: lines.join("\n") || `No tasks with tag "${tag}".` };
      },
    },
  ];
}
