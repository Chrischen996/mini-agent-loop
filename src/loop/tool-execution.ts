import { isAbortError } from "../llm/index.ts";
import { validateToolArgs } from "../validate.ts";
import { nextTodoRevision } from "../todo.ts";
import { MODE_REQUEST_TOOL_NAME } from "../tools/mode-request.ts";
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

/**
 * Surface a model-initiated permission-mode request as a loop event.
 *
 * The tool result carries the intent; this only forwards it. No mode change
 * happens here — the client renders a confirmation card and the permission
 * manager performs the switch once the user accepts it.
 */
export function emitModeRequest(
  onEvent: ((event: LoopEvent) => void) | undefined,
  result: ToolResult,
): void {
  if (!result.modeRequest) return;
  onEvent?.({
    type: "permission_mode_requested",
    mode: result.modeRequest.mode,
    reason: result.modeRequest.reason,
  });
}

/**
 * Collapse several mode requests issued in one assistant response into one.
 *
 * Parallel tool calls all run before the model sees any result, so it can ask
 * for `bypass` and `plan` in the same breath. The client can only show one
 * card, so the last request wins (it is the model's latest intent) and the
 * superseded results are rewritten: leaving "Recorded a request to switch to
 * bypass" in the transcript would describe a card that never appeared.
 *
 * Returns the index of the request to keep, or `undefined` when there is none.
 */
export function coalesceModeRequests(results: readonly ToolResult[]): number | undefined {
  let kept: number | undefined;
  for (let index = 0; index < results.length; index++) {
    if (results[index]?.modeRequest) kept = index;
  }
  if (kept === undefined) return undefined;
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (!result?.modeRequest || index === kept) continue;
    const requested = result.modeRequest.mode;
    result.modeRequest = undefined;
    result.content = [
      `Superseded: this turn also asked to switch to ${results[kept]!.modeRequest!.mode} mode,`,
      `so the ${requested} request was dropped before it reached the user.`,
      "Only one mode request is shown per turn.",
    ].join(" ");
  }
  return kept;
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

  // Only the last mode request in one assistant response reaches the user:
  // the client shows one card, so earlier requests are rewritten as superseded
  // (see `coalesceModeRequests`). The call list is known before execution, so
  // the serial branch can apply the same rule without buffering results.
  let lastModeRequestIndex: number | undefined;
  for (let index = 0; index < calls.length; index++) {
    if (calls[index]?.name === MODE_REQUEST_TOOL_NAME) lastModeRequestIndex = index;
  }
  const emitModeRequestAt = (
    index: number,
    result: ToolResult,
    lastRequestedMode: () => string | undefined,
  ): void => {
    if (!result.modeRequest) return;
    if (lastModeRequestIndex === undefined || index === lastModeRequestIndex) {
      emitModeRequest(onEvent, result);
      return;
    }
    const dropped = result.modeRequest.mode;
    result.modeRequest = undefined;
    result.content = [
      `Superseded: this turn also asked to switch to ${lastRequestedMode() ?? "another mode"},`,
      `so the ${dropped} request was dropped before it reached the user.`,
      "Only one mode request is shown per turn.",
    ].join(" ");
  };

  /** Mode the surviving request asks for, read from its call arguments. */
  const survivingModeRequest = (): string | undefined => {
    if (lastModeRequestIndex === undefined) return undefined;
    const value = calls[lastModeRequestIndex]?.arguments?.mode;
    return typeof value === "string" ? value : undefined;
  };

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

    // Collect results in original call order. Mode requests are coalesced first
    // so only the last one reaches the client (one card, not a flicker).
    const orderedResults: ToolResult[] = [];
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
      orderedResults.push(result);
    }
    coalesceModeRequests(orderedResults);

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;
      const result = orderedResults[i]!;

      emitTodoUpdate(onEvent, result);
      emitModeRequest(onEvent, result);
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

    for (const [index, call] of calls.entries()) {
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
      emitModeRequestAt(index, result, survivingModeRequest);
      onEvent?.({ type: "tool_end", call, result });
    }
  }

  return { toolMessages, wasAborted: false };
}
