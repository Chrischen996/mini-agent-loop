import { isAbortError } from "../llm/index.ts";
import { validateToolArgs } from "../validate.ts";
import { nextTodoRevision } from "../todo.ts";
import type { Tool, ToolResult } from "../tools/types.ts";
import type { AgentMessage, ToolCall, ToolResultMessage } from "../types.ts";
import type { LoopEvent } from "../loop.ts";

export function emitTodoUpdate(
  onEvent: ((event: LoopEvent) => void) | undefined,
  result: ToolResult,
): void {
  if (!result.todoUpdate) return;
  onEvent?.({
    type: "todo_updated",
    todos: result.todoUpdate,
    revision: nextTodoRevision(),
  });
}

export function appendStoppedToolResults(
  messages: AgentMessage[],
  calls: ToolCall[],
  completedIds: Set<string>,
  onEvent?: (event: LoopEvent) => void,
): void {
  for (const call of calls) {
    if (completedIds.has(call.id)) continue;
    const result: ToolResult = { content: "已停止", isError: true };
    messages.push({
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      content: result.content,
      isError: true,
    });
    onEvent?.({ type: "tool_end", call, result });
  }
}

export type ExecuteTurnToolsOptions = {
  calls: ToolCall[];
  turnTools: Tool[];
  parallel: boolean;
  executeTool: (tool: Tool, args: Record<string, unknown>) => Promise<ToolResult>;
  emitToolStart: (call: ToolCall) => void;
  onEvent?: (event: LoopEvent) => void;
  activeSignal?: AbortSignal;
  messages: AgentMessage[];
};

export async function executeTurnTools(
  options: ExecuteTurnToolsOptions,
): Promise<{
  toolMessages: ToolResultMessage[];
  wasAborted: boolean;
}> {
  const {
    calls,
    turnTools,
    parallel,
    executeTool,
    emitToolStart,
    onEvent,
    activeSignal,
    messages,
  } = options;

  let toolMessages: ToolResultMessage[] = [];
  let wasAborted = false;

  if (parallel && calls.length > 1) {
    // ── Parallel execution ─────────────────────────────────────
    // Emit all tool_start events up front
    for (const call of calls) {
      emitToolStart(call);
    }

    const settled = await Promise.allSettled(
      calls.map(async (call): Promise<{ call: ToolCall; result: ToolResult }> => {
        if (call.argumentsParseError) {
          return {
            call,
            result: {
              content: `Invalid tool arguments JSON: ${call.argumentsParseError}`,
              isError: true,
            },
          };
        }
        const tool = turnTools.find((t) => t.name === call.name);
        if (!tool) {
          return {
            call,
            result: { content: `Unknown tool: ${call.name}`, isError: true },
          };
        }
        const args = validateToolArgs(tool, call.arguments);
        const result = await executeTool(tool, args);
        return { call, result };
      }),
    );

    // Collect results in original call order
    for (let i = 0; i < calls.length; i++) {
      const outcome = settled[i]!;
      const call = calls[i]!;
      let result: ToolResult;

      if (outcome.status === "fulfilled") {
        result = outcome.value.result;
      } else {
        const err = outcome.reason;
        if (isAbortError(err)) {
          result = { content: "已停止", isError: true };
          wasAborted = true;
        } else {
          result = {
            content: err instanceof Error ? err.message : String(err),
            isError: true,
          };
        }
      }

      emitTodoUpdate(onEvent, result);
      toolMessages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: result.content,
        isError: result.isError,
      });
      onEvent?.({ type: "tool_end", call, result });
    }

    if (wasAborted) {
      messages.push(...toolMessages);
      return { toolMessages, wasAborted: true };
    }
  } else {
    // ── Serial execution (default) ─────────────────────────────
    const completedToolIds = new Set<string>();

    for (const call of calls) {
      if (activeSignal?.aborted) {
        messages.push(...toolMessages);
        appendStoppedToolResults(messages, calls, completedToolIds, onEvent);
        return { toolMessages, wasAborted: true };
      }
      emitToolStart(call);

      let result: ToolResult;

      if (call.argumentsParseError) {
        result = {
          content: `Invalid tool arguments JSON: ${call.argumentsParseError}`,
          isError: true,
        };
      } else {
        const tool = turnTools.find((t) => t.name === call.name);
        if (!tool) {
          result = {
            content: `Unknown tool: ${call.name}`,
            isError: true,
          };
        } else {
          try {
            const args = validateToolArgs(tool, call.arguments);
            result = await executeTool(tool, args);
          } catch (err) {
            if (isAbortError(err)) {
              result = { content: "已停止", isError: true };
              toolMessages.push({
                role: "tool",
                toolCallId: call.id,
                name: call.name,
                content: result.content,
                isError: true,
              });
              completedToolIds.add(call.id);
              onEvent?.({ type: "tool_end", call, result });
              messages.push(...toolMessages);
              appendStoppedToolResults(messages, calls, completedToolIds, onEvent);
              return { toolMessages, wasAborted: true };
            }
            result = {
              content: err instanceof Error ? err.message : String(err),
              isError: true,
            };
          }
        }
      }

      toolMessages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: result.content,
        isError: result.isError,
      });
      completedToolIds.add(call.id);
      emitTodoUpdate(onEvent, result);
      onEvent?.({ type: "tool_end", call, result });
    }
  }

  return { toolMessages, wasAborted: false };
}
