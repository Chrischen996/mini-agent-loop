// Wire-safe projections of loop state for the Express/NDJSON server.
//
// Split out of `src/server.ts`: `safeMessage` / `safeEvent` are pure
// serializers (with credential redaction) that the route handlers and the
// in-factory plan-execution streaming share. They carry no factory state, so
// they live here to keep the server factory slim; `isRetryableError` is the
// matching client-facing classifier used by the same streaming paths.

import { contentAsString } from "../content.ts";
import type { LoopEvent } from "../loop.ts";
import type { AgentMessage } from "../types.ts";

export function safeMessage(message: AgentMessage): Record<string, unknown> {
  if (message.role === "system" || message.role === "assistant") {
    return {
      role: message.role,
      ...(message.id ? { id: message.id } : {}),
      content: message.content,
      ...(message.role === "assistant" && message.toolCalls
        ? {
            toolCalls: message.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              arguments: redactSensitiveArguments(call.arguments),
            })),
          }
        : {}),
    };
  }
  if (message.role === "user") {
    return {
      role: "user",
      ...(message.id ? { id: message.id } : {}),
      content: contentAsString(message.content),
    };
  }
  return {
    role: "tool",
    ...(message.id ? { id: message.id } : {}),
    toolCallId: message.toolCallId,
    name: message.name,
    content: contentAsString(message.content),
    isError: Boolean(message.isError),
  };
}

export function safeEvent(event: LoopEvent): Record<string, unknown> {
  switch (event.type) {
    case "assistant_delta":
      return {
        type: "assistant_delta",
        text: event.text,
        kind: event.kind,
      };
    case "context_compacted":
      return {
        type: "context_compacted",
        beforeTokens: event.beforeTokens,
        afterTokens: event.afterTokens,
        reason: event.reason,
      };
    case "assistant":
      return {
        type: "assistant",
        content: event.message.content,
        tools: event.message.toolCalls?.map((call) => call.name) ?? [],
      };
    case "error":
      return { type: "error", message: event.message };
    case "max_turns":
      return {
        type: "max_turns",
        maxTurns: event.maxTurns,
        message: (event as { message?: string }).message,
        messageCount: event.messages.length,
      };
    case "run_stopped":
      return {
        type: "run_stopped",
        stopReason: event.stopReason,
        details: event.details,
        message: event.message ?? event.details ?? `Run stopped: ${event.stopReason}`,
        budgetUsage: event.budgetUsage,
        cumulativeBudgetUsage: event.cumulativeBudgetUsage,
        budgetPolicy: event.budgetPolicy,
        messageCount: event.messages.length,
      };
    case "tool_start":
      return {
        type: "tool_start",
        id: event.call.id,
        name: event.call.name,
        arguments: redactSensitiveArguments(event.call.arguments),
      };
    case "tool_end":
      return {
        type: "tool_end",
        id: event.call.id,
        name: event.call.name,
        isError: Boolean(event.result.isError),
        preview: contentAsString(event.result.content).slice(0, 500),
      };
    case "auto_subagent":
      return {
        type: "auto_subagent",
        shouldDelegate: event.shouldDelegate,
        executed: event.executed,
        coordinatorMode: event.coordinatorMode,
        score: event.score,
        profile: event.profile,
        reasons: event.reasons.slice(0, 12),
      };
    case "coordinator_mode":
      return {
        type: "coordinator_mode",
        active: event.active,
        profile: event.profile,
        preflightExecuted: event.preflightExecuted,
        maxDirectExploration: event.maxDirectExploration,
        directExplorationUsed: event.directExplorationUsed,
        reasons: event.reasons.slice(0, 12),
      };
    case "thinking_policy":
      return {
        type: "thinking_policy",
        mode: event.mode,
        phase: event.phase,
        previousLevel: event.previousLevel,
        level: event.level,
        score: event.score,
        reasons: event.reasons.slice(0, 12),
      };
    case "permission_required":
      return {
        type: "permission_required",
        requestId: event.request.id,
        tool: event.request.tool,
        arguments: redactSensitiveArguments(event.request.arguments),
        risk: event.request.risk,
        source: event.request.source,
      };
    case "aborted":
      return {
        type: "aborted",
        message: "已停止生成",
        messageCount: event.messages.length,
        ...(event.reason ? {
          reason: event.reason,
          previousMode: event.previousMode,
          permissionMode: event.permissionMode,
        } : {}),
      };
    case "plan_act_event":
      return { eventType: event.event.type, ...event.event };
    case "done":
      return { type: "done", messageCount: event.messages.length };
    case "attempt_reset":
      return {
        type: "attempt_reset",
        reason: event.reason,
        attempt: event.attempt,
      };
    case "model_switched":
      return {
        type: "model_switched",
        previousModel: event.previousModel,
        nextModel: event.nextModel,
        turn: event.turn,
      };
    case "retry_attempt":
      return {
        type: "retry_attempt",
        errorType: event.errorType,
        attempt: event.attempt,
        maxRetries: event.maxRetries,
        delayMs: event.delayMs,
        errorMessage: event.errorMessage.slice(0, 200),
      };
    case "goal_updated":
      return {
        type: "goal_updated",
        goal: event.goal,
        reason: event.reason,
      };
    case "subagent_start":
      return {
        type: "subagent_start",
        id: event.id,
        task: event.task.slice(0, 500),
        profile: event.profile,
        depth: event.depth,
        runtime: event.runtime,
      };
    case "subagent_event":
      return {
        type: "subagent_event",
        id: event.id,
        depth: event.depth,
        inner: safeEvent(event.inner),
      };
    case "budget_warning":
      return {
        type: "budget_warning",
        id: event.id,
        used: event.used,
        limit: event.limit,
        percentage: event.percentage,
        depth: event.depth,
      };
    case "subagent_end":
      return {
        type: "subagent_end",
        id: event.id,
        success: event.success,
        depth: event.depth,
        turns: event.turns,
        totalTokens: event.totalTokens,
        resultPreview: event.result.slice(0, 300),
        runtime: event.runtime,
        autoDelegationInherited: event.autoDelegationInherited,
        ...(event.tokenBreakdown ? { tokenBreakdown: event.tokenBreakdown } : {}),
        ...(event.estimatedCost ? { estimatedCost: event.estimatedCost } : {}),
        ...(event.errors ? {
          errors: event.errors.map((error) => ({
            kind: error.kind,
            message: error.message.slice(0, 500),
          })),
        } : {}),
      };
    default: {
      const exhaustive = event as { type: string };
      return { type: exhaustive.type };
    }
  }
}

function redactSensitiveArguments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveArguments);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
    key,
    /authorization|cookie|password|secret|token|api[_-]?key/i.test(key)
      ? "[REDACTED]"
      : redactSensitiveArguments(child),
  ]));
}

export function isRetryableError(message: string): boolean {
  return /Vision provider .* is busy|Vision network error|Vision HTTP (429|502|503|504)/i.test(
    message,
  );
}
