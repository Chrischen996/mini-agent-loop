import { randomUUID } from "node:crypto";
import type { Dispatch } from "react";
import type { TuiAction } from "./state.ts";
import type { PermissionManager } from "../permissions.ts";
import type { ToolCall } from "../types.ts";
import type { ToolProvider, ToolResult } from "../tools/types.ts";
import { resolveToolProvider } from "../tools/types.ts";
import { ToolExecutionBroker } from "../runtime/tool-execution-broker.ts";
import { nextTodoRevision } from "../todo.ts";

export type DirectToolRunnerDeps = {
  allTools: ToolProvider;
  permissionSessionId: string;
  getPermissionManager: () => PermissionManager;
  abortSignal: AbortSignal;
  dispatch: Dispatch<TuiAction>;
  toolExecutionBroker?: ToolExecutionBroker;
};

export type DirectToolRunResult = {
  call: ToolCall;
  result: ToolResult;
};

/**
 * Execute a tool directly without going through the agent loop.
 */
export async function runDirectTool(
  toolName: string,
  args: Record<string, unknown>,
  deps: DirectToolRunnerDeps,
): Promise<DirectToolRunResult> {
  const { allTools, permissionSessionId, getPermissionManager, abortSignal, dispatch } = deps;

  const tool = resolveToolProvider(allTools).find((t) => t.name === toolName);
  const fakeCall: ToolCall = { id: `direct-${randomUUID()}`, name: toolName, arguments: args };

  if (!tool) {
    const result: ToolResult = { content: `Unknown tool: ${toolName}`, isError: true };
    dispatch({
      type: "LOOP_EVENT",
      event: { type: "tool_end", call: fakeCall, result },
    });
    return { call: fakeCall, result };
  }

  dispatch({ type: "LOOP_EVENT", event: { type: "tool_start", call: fakeCall } });

  const permissionManager = getPermissionManager();
  const permissionTurn = permissionManager.beginTurn(
    permissionSessionId,
    (request) => dispatch({ type: "LOOP_EVENT", event: { type: "permission_required", request } }),
    abortSignal,
  );

  try {
    const result = await (deps.toolExecutionBroker ?? new ToolExecutionBroker()).execute(tool, args, {
      signal: abortSignal,
      permissionTurn,
    });
    if (result.todoUpdate) {
      dispatch({
        type: "LOOP_EVENT",
        event: { type: "todo_updated", todos: result.todoUpdate, revision: nextTodoRevision() },
      });
    }
    dispatch({ type: "LOOP_EVENT", event: { type: "tool_end", call: fakeCall, result } });
    return { call: fakeCall, result };
  } catch (err) {
    const result: ToolResult = {
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    };
    dispatch({
      type: "LOOP_EVENT",
      event: {
        type: "tool_end",
        call: fakeCall,
        result,
      },
    });
    return { call: fakeCall, result };
  } finally {
    permissionTurn.close();
  }
}
