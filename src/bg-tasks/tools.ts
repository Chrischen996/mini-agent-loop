import type { Tool, JsonSchema } from "../tools/types.ts";
import type { BgTaskManager } from "./manager.js";

export function createBgTaskTools(manager: BgTaskManager): Tool[] {
  return [
    {
      name: "bg_start",
      description:
        "Start a shell command in a persistent tmux-backed background terminal and return immediately with its task ID.",
      displayName: "Background Task",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
          name: { type: "string", description: "Optional task name (defaults to command prefix)" },
          cwd: { type: "string", description: "Working directory (absolute or relative to project cwd)" },
          timeoutSeconds: { type: "integer", minimum: 1, maximum: 604_800, description: "Optional timeout in seconds" },
        },
        required: ["command"],
        additionalProperties: false,
      } as JsonSchema,
      execute: async (args, signal) => {
        if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
        const task = await manager.start({
          command: String(args.command ?? ""),
          name: args.name !== undefined ? String(args.name) : undefined,
          cwd: args.cwd !== undefined ? String(args.cwd) : undefined,
          timeoutSeconds: args.timeoutSeconds !== undefined ? Number(args.timeoutSeconds) : undefined,
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
      description: "Send literal text or Enter to a running background task via tmux.",
      displayName: "Task Input",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          text: { type: "string" },
          enter: { type: "boolean" },
        },
        required: ["taskId"],
        additionalProperties: false,
      } as JsonSchema,
      execute: async (args, signal) => {
        if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
        const task = await manager.send(String(args.taskId), {
          text: args.text !== undefined ? String(args.text) : undefined,
          enter: args.enter === true,
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
      description: "Gracefully cancel a running background task, or force-close its tmux session.",
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
  ];
}
