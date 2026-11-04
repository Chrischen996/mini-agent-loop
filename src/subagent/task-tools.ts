import type { JsonSchema, Tool } from "../tools/types.ts";
import type { SubagentTaskRegistry } from "./task-registry.ts";

const idListSchema: JsonSchema = {
  type: "object",
  properties: {
    taskIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
  },
  required: ["taskIds"],
  additionalProperties: false,
};

function idsFrom(args: Record<string, unknown>): string[] {
  return Array.isArray(args.taskIds) ? args.taskIds.map(String) : [];
}

export function createSubagentTaskTools(registry: SubagentTaskRegistry): Tool[] {
  return [
    {
      name: "subagent_send",
      displayName: "Send to Sub-agent",
      description: "Queue an additional instruction for a running sub-agent. It is added to the sub-agent conversation before its next model turn.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The running sub-agent task ID." },
          message: { type: "string", minLength: 1, maxLength: 20_000, description: "The instruction to add to the running task." },
        },
        required: ["taskId", "message"],
        additionalProperties: false,
      },
      execute: async (args, signal, execution) => {
        if (signal?.aborted) return { content: "Operation aborted.", isError: true };
        const taskId = String(args.taskId ?? "");
        const message = String(args.message ?? "");
        const queued = await registry.sendInputMessage(taskId, message, execution?.sessionId);
        return queued
          ? { content: `Message queued for sub-agent task ${taskId}.` }
          : { content: "The task is not running, does not belong to this session, or its input queue is full.", isError: true };
      },
    },
    {
      name: "subagent_tasks",
      displayName: "Sub-agent Tasks",
      description: "List sub-agent tasks owned by this session, including active, completed, failed, cancelled, and interrupted tasks.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_args, signal, execution) => {
        if (signal?.aborted) return { content: "Operation aborted.", isError: true };
        const tasks = await registry.list(execution?.sessionId);
        return { content: JSON.stringify(tasks.map(({ taskId, task, profile, status, createdAt, endedAt, result, error }) => ({ taskId, task, profile, status, createdAt, endedAt, result, error })), null, 2) };
      },
    },
    {
      name: "subagent_output",
      displayName: "Sub-agent Output",
      description: "Read the current status and final output of one or more sub-agent tasks. Reading a completed result counts as consuming its completion and suppresses a duplicate auto-wake.",
      parameters: idListSchema,
      execute: async (args, signal, execution) => {
        if (signal?.aborted) return { content: "Operation aborted.", isError: true };
        const ids = idsFrom(args);
        if (ids.length === 0) return { content: "taskIds must contain at least one task ID.", isError: true };
        const ownership = await Promise.all(ids.map((id) => registry.get(id, execution?.sessionId)));
        if (ownership.some((record) => record === undefined)) return { content: "One or more task IDs are invalid or do not belong to this session.", isError: true };
        const records = await Promise.all(ids.map((id) => registry.readOutput(id, execution?.sessionId)));
        const visible = records.filter((record) => record !== undefined);
        if (visible.length === 0) return { content: "No matching sub-agent tasks were found for this session.", isError: true };
        return { content: JSON.stringify(visible.map(({ taskId, status, result, error, isError, partial, createdAt, endedAt }) => ({ taskId, status, result, error, isError, partial, createdAt, endedAt })), null, 2) };
      },
    },
    {
      name: "subagent_wait",
      displayName: "Wait for Sub-agents",
      description: "Wait for one or more background sub-agents. A completed result observed by this wait is consumed and will not produce a duplicate completion auto-wake. A timeout leaves running tasks eligible to wake later.",
      parameters: {
        type: "object",
        properties: {
          ...((idListSchema.properties as Record<string, unknown>) ?? {}),
          mode: { type: "string", enum: ["all", "any"], description: "Whether to wait for all tasks or the first task to finish. Defaults to all." },
          timeoutMs: { type: "integer", minimum: 0, maximum: 600_000, description: "Maximum wait duration in milliseconds. Defaults to 30000; 0 returns immediately." },
        },
        required: ["taskIds"],
        additionalProperties: false,
      } as JsonSchema,
      execute: async (args, signal, execution) => {
        if (signal?.aborted) return { content: "Operation aborted.", isError: true };
        const ids = idsFrom(args);
        if (ids.length === 0) return { content: "taskIds must contain at least one task ID.", isError: true };
        const ownership = await Promise.all(ids.map((id) => registry.get(id, execution?.sessionId)));
        if (ownership.some((record) => record === undefined)) return { content: "One or more task IDs are invalid or do not belong to this session.", isError: true };
        const result = await registry.wait(
          ids,
          args.mode === "any" ? "any" : "all",
          args.timeoutMs === undefined ? 30_000 : Math.max(0, Number(args.timeoutMs)),
          signal,
          execution?.sessionId,
        );
        return { content: JSON.stringify({ ...result, completed: result.completed.map(({ taskId, status, result: output, error, isError, partial }) => ({ taskId, status, result: output, error, isError, partial })) }, null, 2) };
      },
    },
    {
      name: "subagent_kill",
      displayName: "Stop Sub-agent",
      description: "Cancel one or more running sub-agent tasks owned by this session. Killed tasks do not auto-wake the parent on completion.",
      parameters: idListSchema,
      execute: async (args, signal, execution) => {
        if (signal?.aborted) return { content: "Operation aborted.", isError: true };
        const ids = idsFrom(args);
        if (ids.length === 0) return { content: "taskIds must contain at least one task ID.", isError: true };
        const ownership = await Promise.all(ids.map((id) => registry.get(id, execution?.sessionId)));
        if (ownership.some((record) => record === undefined)) return { content: "One or more task IDs are invalid or do not belong to this session.", isError: true };
        const records = await Promise.all(ids.map((id) => registry.kill(id, execution?.sessionId)));
        const visible = records.filter((record) => record !== undefined);
        if (visible.length === 0) return { content: "No matching sub-agent tasks were found for this session.", isError: true };
        return { content: JSON.stringify(visible.map(({ taskId, status, killed }) => ({ taskId, status, killed })), null, 2) };
      },
    },
  ];
}
