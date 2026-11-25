// `SUBAGENT_EVENT` projection for the Ink session state.
//
// Split out of `state.ts`: the subagent card lifecycle (start / inner events /
// budget warning / end) was the largest block inside `tuiReducer` and carried
// its own private helpers. The shared helpers it reuses (message updates,
// transcript pruning) stay in `../state.ts` and are imported here, mirroring
// the `loop-events.ts` split.

import type { SubagentEvent } from "../../subagent/types.ts";
import { STATUS_DONE, STATUS_ERROR } from "../render-lines.ts";
import { toolArgumentSummary } from "../claude-style.ts";
import { toolVisualName } from "../tool-lines.ts";
import { compactText } from "../text-utils.ts";
import {
  pruneTranscriptAndDictionaries,
  updateSubagentMessage,
  type ChatMessage,
  type TuiState
} from "../state.ts";

const MAX_SUBAGENT_INNER_EVENTS = 100;

function isHighFrequencySubagentEvent(type: string): boolean {
  return type === "assistant_delta" || type === "assistant_deltas";
}

export function reduceSubagentEvent(
  state: TuiState,
  event: SubagentEvent,
): TuiState {
  switch (event.type) {
    case "subagent_start": {
      const card: ChatMessage = {
        kind: "subagent_call",
        id: event.id,
        task: event.task,
        profile: event.profile,
        depth: event.depth,
        status: "running",
        innerEvents: [],
        toolCallCount: 0,
        startedAt: Date.now(),
        expanded: false,
      };
      const newMessages: ChatMessage[] = [...state.messages, card];
      const revision = state.subagentRevision + 1;
      const baseNext: TuiState = {
        ...state,
        messages: newMessages,
        subagentById: { ...state.subagentById, [event.id]: card },
        subagentIndexById: { ...state.subagentIndexById, [event.id]: newMessages.length - 1 },
        subagentRevision: revision,
        subagentChange: { id: event.id, index: newMessages.length - 1, revision },
        status: `Delegating (depth ${event.depth})…`,
      };
      return pruneTranscriptAndDictionaries(baseNext);
    }
    case "subagent_event": {
      const inner = event.inner;
      // Child answer deltas are useful to the parent model, but they are
      // too frequent and too verbose for the transcript. The child result
      // and concrete tool lifecycle events remain visible below.
      if (isHighFrequencySubagentEvent(inner.type)) return state;
      const label =
        inner.type === "tool_start" ? `▶ ${inner.call.name}`
        : inner.type === "tool_end" ? `${inner.result.isError ? STATUS_ERROR : STATUS_DONE} ${inner.call.name}`
        : inner.type === "assistant" ? "💬 assistant"
        : inner.type === "error" ? `${STATUS_ERROR} ${inner.message}`
        : inner.type;
      const detail =
        inner.type === "tool_start" ? compactText(JSON.stringify(inner.call.arguments), 80, "…")
        : inner.type === "tool_end" ? compactText(typeof inner.result.content === "string" ? inner.result.content : "[complex]", 80, "…")
        : undefined;
      const isToolEnd = inner.type === "tool_end";
      const lastToolInfo = inner.type === "tool_start"
        ? (() => {
            const summary = toolArgumentSummary(inner.call.name, inner.call.arguments, JSON.stringify(inner.call.arguments)).replace(/^\$\s*/, "");
            return `${toolVisualName(inner.call.name)}${summary ? `(${summary})` : ""}`;
          })()
        : undefined;
      return updateSubagentMessage(state, event.id, (message) => ({
        ...message,
        innerEvents: [...message.innerEvents, { type: inner.type, label, detail }].slice(-MAX_SUBAGENT_INNER_EVENTS),
        toolCallCount: message.toolCallCount + (isToolEnd ? 1 : 0),
        ...(lastToolInfo ? { lastToolInfo } : {}),
      }));
    }
    case "budget_warning": {
      const next = updateSubagentMessage(state, event.id, (message) => ({
        ...message,
        innerEvents: [...message.innerEvents, {
          type: "budget_warning",
          label: `⚠ budget ${event.percentage}% (${event.used}/${event.limit})`,
        }].slice(-MAX_SUBAGENT_INNER_EVENTS),
      }));
      return next === state ? state : { ...next, status: `Budget warning ${event.percentage}%` };
    }
    case "subagent_end": {
      const now = Date.now();
      const next = updateSubagentMessage(state, event.id, (message) => ({
        ...message,
        status: event.success ? "done" as const : (event.partial ? "partial" as const : "error" as const),
        result: event.result,
        turns: event.turns,
        totalTokens: event.totalTokens || undefined,
        tokenBreakdown: event.tokenBreakdown,
        estimatedCost: event.estimatedCost,
        durationMs: now - message.startedAt,
      }));
      return next === state ? state : {
        ...next,
        status: event.success ? "Subagent done" : (event.partial ? "Subagent partial result" : "Subagent failed"),
      };
    }
    default:
      return state;
  }
}

export function toggleSubagentExpand(state: TuiState, id: string): TuiState {
  return updateSubagentMessage(state, id, (message) => ({
    ...message,
    expanded: !message.expanded,
  }));
}
