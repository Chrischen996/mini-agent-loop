// `LOOP_EVENT` projection for the Ink session state.
//
// Split out of `state.ts`: 19 event kinds shared a single 458-line switch case
// inside `tuiReducer`, which made the reducer impossible to scan. The function
// is a pure projection — same state plus same event always yields the same next
// state — and returns `state` unchanged when an event has nothing to apply, so
// React can skip the re-render.
//
// Helpers it shares with the main reducer (prune/append/tool-message updates)
// stay in `../state.ts` and are imported here to avoid duplicating them.

import type { LoopEvent } from "../../loop.ts";
import { computeCommitBoundary } from "../stream-commit.ts";
import { compactText } from "../text-utils.ts";
import { isTodoRevisionNewer, TODO_WRITE_TOOL_NAME } from "../../todo.ts";
import { MODE_REQUEST_TOOL_NAME } from "../../tools/mode-request.ts";
import {
  appendStreamingParts,
  appendStreamingPreview,
  offloadTranscript,
  pruneTranscriptAndDictionaries,
  resultContent,
  resultPreview,
  taskDuration,
  todoSpinnerMessage,
  toolLabel,
  toolPaths,
  updateToolMessage,
  type ChatMessage,
  type ToolCardState,
  type ToolState,
  type TuiState,
  type WorkflowStep
} from "../state.ts";

export function reduceLoopEvent(
  state: TuiState,
  event: LoopEvent,
  /** Re-dispatch hook: some loop events are projected onto another action. */
  reducer: (state: TuiState, action: import("../state.ts").TuiAction) => TuiState,
): TuiState {
    switch (event.type) {
      case "todo_updated":
        if (!isTodoRevisionNewer(state.todoRevision, event.revision)) return state;
        return {
          ...state,
          todos: event.todos,
          todoItems: event.todos,
          todoRevision: event.revision,
          status: "Todos updated",
          spinnerMessage: todoSpinnerMessage(event.todos),
        };

      case "assistant_delta": {
        const answer = event.kind === "answer" ? event.text : "";
        const reasoning = event.kind === "reasoning" ? event.text : "";
        return {
          ...state,
          streamingText: appendStreamingPreview(state.streamingText, answer),
          streamingReasoning: appendStreamingPreview(state.streamingReasoning, reasoning),
          streamingTextParts: appendStreamingParts(state.streamingTextParts, answer || undefined),
          streamingReasoningParts: appendStreamingParts(state.streamingReasoningParts, reasoning || undefined),
          lastStreamAt: Date.now(),
          status: "Responding…",
        };
      }

      case "assistant_deltas": {
        // Coalesced by TurnEventBuffer.flush(): at most one reasoning chunk and
        // one answer chunk per 80 ms window. Keep the hot preview bounded;
        // full chunks are joined only when the assistant message is finalized.
        const answer = event.answer ?? "";
        const reasoning = event.reasoning ?? "";
        return {
          ...state,
          streamingText: appendStreamingPreview(state.streamingText, answer),
          streamingReasoning: appendStreamingPreview(state.streamingReasoning, reasoning),
          streamingTextParts: appendStreamingParts(state.streamingTextParts, answer || undefined),
          streamingReasoningParts: appendStreamingParts(state.streamingReasoningParts, reasoning || undefined),
          lastStreamAt: Date.now(),
          status: "Responding…",
        };
      }

      case "assistant": {
        // Prefer streamed text; the final assistant event often has content=""
        const contentText = typeof event.message.content === "string"
          ? event.message.content
          : "";
        const streamedText = state.streamingTextParts.join("") || state.streamingText;
        const streamedReasoning = state.streamingReasoningParts.join("") || state.streamingReasoning;
        const text = contentText || streamedText;
        let lastUserIndex = -1;
        for (let index = state.messages.length - 1; index >= 0; index -= 1) {
          if (state.messages[index]?.kind === "user") {
            lastUserIndex = index;
            break;
          }
        }
        let previousAssistant: Extract<ChatMessage, { kind: "assistant" }> | undefined;
        for (let index = state.messages.length - 1; index > lastUserIndex; index -= 1) {
          const message = state.messages[index];
          if (message?.kind === "assistant") {
            previousAssistant = message;
            break;
          }
        }
        const previousReasoning = previousAssistant?.reasoning;
        const completedReasoning = (event.message.thinking ?? [])
          .map((part) => part.thinking)
          .filter((thinking) => thinking.trim().length > 0)
          .join("\n");
        const reasoning = completedReasoning || streamedReasoning || previousReasoning;
        const hasTools = (event.message.toolCalls?.length ?? 0) > 0;
        // Only skip if we genuinely have nothing to show
        if (!text && !reasoning && !hasTools) return {
          ...state,
          streamingText: "",
          streamingReasoning: "",
          streamingTextParts: [],
          streamingReasoningParts: [],
          // Keep streamRetryCommittedText: a pending retry seal still needs
          // the frozen-prefix baseline for dedup; it clears with the next
          // user turn or terminal event.
        };

        const isDuplicate = previousAssistant?.text === text
          && previousAssistant.reasoning === reasoning;
        const reasoningOnlyAssistant = previousAssistant?.text === ""
          && previousAssistant.reasoning !== undefined
          && Boolean(text);
        const removedAssistantIndex = reasoningOnlyAssistant
          ? previousAssistant
            ? state.messages.indexOf(previousAssistant)
            : -1
          : -1;
        const baseMessages = reasoningOnlyAssistant
          ? state.messages.filter((message) => message !== previousAssistant)
          : state.messages;
        
        const assistantMsg: ChatMessage = { kind: "assistant", text: text || "", ...(reasoning ? { reasoning } : {}) };
        const newMessages: ChatMessage[] = (text || reasoning) && !isDuplicate
          ? [...baseMessages, assistantMsg]
          : baseMessages;
        const remapMessageIndex = (index: number): number => {
          if (removedAssistantIndex < 0 || index < 0) return index;
          if (index === removedAssistantIndex) return newMessages.length - 1;
          return index > removedAssistantIndex ? index - 1 : index;
        };
        const expandedThinking = state.expandedThinking
          .map(remapMessageIndex)
          .sort((a, b) => a - b);
        const focusedMessageIndex = remapMessageIndex(state.focusedMessageIndex);
        const usedTokens = event.usage?.totalTokens ?? state.usedTokens;
        const contextTokens = event.usage?.promptTokens ?? state.contextTokens;
        const cacheReadTokens = event.usage?.cacheReadTokens ?? state.cacheReadTokens;
        const baseNext: TuiState = {
          ...state,
          messages: newMessages,
          expandedThinking,
          focusedMessageIndex,
          streamingText: "",
          streamingReasoning: "",
          streamingTextParts: [],
          streamingReasoningParts: [],
          // Do NOT clear streamRetryCommittedText here: in a pure-text turn
          // this assistant event seals the retried stream, and the seal
          // dedup needs the frozen-prefix baseline set by attempt_reset.
          // USER_MESSAGE / error / run_stopped / max_turns clear it.
          status: hasTools ? "Running tool…" : "Finalizing response…",
          // Track the frozen streaming prefix of the just-finalized message
          // so the document-layout frame can drop those rows when the
          // sealed prefix stops at an un-sealable entry (subagent card).
          // The retry baseline takes precedence: during a retried stream the
          // commit channel is suppressed, so only the frozen prefix was
          // ever committed.
          streamSealPending:
            (text || reasoning) && !isDuplicate
              ? {
                  message: assistantMsg as Extract<ChatMessage, { kind: "assistant" }>,
                  committedText:
                    state.streamRetryCommittedText ??
                    (state.streamingText.slice(0, computeCommitBoundary(state.streamingText)) || ""),
                }
              : state.streamSealPending,
          usedTokens,
          taskTokens: state.taskTokens + (event.usage?.totalTokens ?? 0),
          contextTokens,
          cacheReadTokens,
        };
        return pruneTranscriptAndDictionaries(baseNext);
      }

      case "error": {
        const isTruncated = /max_tokens|output reached|OutputTruncatedError/i.test(event.message);
        const errorText = isTruncated
          ? `${event.message}\n\n💡 Tip: Use /continue to resume the response, or switch to a model with higher max_tokens.`
          : event.message;
        const newMessages: ChatMessage[] = [...state.messages, { kind: "error", text: errorText }];
        const baseNext: TuiState = {
          ...state,
          busy: false,
          messages: newMessages,
          streamingText: "",
          streamingReasoning: "",
          streamingTextParts: [],
          streamingReasoningParts: [],
          streamRetryCommittedText: undefined,
          streamSealPending: undefined,
          turnStartedAt: undefined,
          lastStreamAt: undefined,
          pendingPermission: undefined,
          spinnerMessage: undefined,
          status: isTruncated ? "Output truncated" : "Request failed",
          taskStatus: "failed",
          taskDurationMs: taskDuration(state.taskStartedAt),
        };
        return pruneTranscriptAndDictionaries(baseNext);
      }

      case "attempt_reset":
        // A retried stream may reproduce the answer prefix that has already
        // been frozen into document-mode scrollback. Preserve that prefix
        // for seal dedup and stop incremental commits until sealing.
        return {
          ...state,
          streamingText: "",
          streamingReasoning: "",
          streamingTextParts: [],
          streamingReasoningParts: [],
          // An existing baseline already tracks everything frozen in the
          // scrollback (the commit effect is suppressed while it is set),
          // so a second truncation during the retried stream must keep it
          // rather than mix uncommitted re-streamed text into the dedup
          // baseline.
          streamRetryCommittedText: state.streamRetryCommittedText
            || state.streamingText.slice(0, computeCommitBoundary(state.streamingText))
            || undefined,
          lastStreamAt: undefined,
          status: event.reason === "stream_truncated"
            ? `Connection lost, retrying (${event.attempt})…`
            : `Incomplete reasoning, retrying (${event.attempt})…`,
        };

      case "retry_attempt":
        return {
          ...state,
          streamingText: "",
          streamingReasoning: "",
          streamingTextParts: [],
          streamingReasoningParts: [],
          streamRetryCommittedText: state.streamRetryCommittedText
            || state.streamingText.slice(0, computeCommitBoundary(state.streamingText))
            || undefined,
          lastStreamAt: undefined,
          status: event.errorType === "timeout"
            ? `Request timed out, retrying (${event.attempt}/${event.maxRetries})…`
            : `Request failed, retrying (${event.attempt}/${event.maxRetries})…`,
        };

      case "run_stopped":
      case "max_turns": {
        const details = event.type === "max_turns"
          ? "Run stopped by its safety cap."
          : event.details ?? event.message ?? `Run stopped: ${event.stopReason}.`;
        const usage = event.type === "run_stopped" ? event.budgetUsage : undefined;
        const consumption = usage
          ? `\nUsed: ${usage.tokensUsed} tokens · ${usage.toolCallsUsed} tool calls · ${usage.writeCallsUsed} writes · ${Math.ceil(usage.elapsedMs / 1000)}s.`
          : "";
        const newMessages: ChatMessage[] = [...state.messages, {
          kind: "notice", title: "Run paused",
          text: `${details}${consumption}\nUse /continue to resume with a new run budget, or submit new instructions.`,
        }];
        const baseNext: TuiState = {
          ...state,
          messages: newMessages,
          busy: false,
          taskStatus: "paused",
          taskDurationMs: taskDuration(state.taskStartedAt),
          streamingText: "",
          streamingReasoning: "",
          streamingTextParts: [],
          streamingReasoningParts: [],
          streamRetryCommittedText: undefined,
          streamSealPending: undefined,
          turnStartedAt: undefined,
          lastStreamAt: undefined,
          pendingPermission: undefined,
          spinnerMessage: undefined,
          status: "Paused · /continue to resume",
        };
        return pruneTranscriptAndDictionaries(baseNext);
      }

      case "context_compacted": {
        const compaction = {
          before: event.beforeTokens,
          after: event.afterTokens,
          reason: event.reason,
          // LoopEvent currently does not expose the model turn number. Keep
          // a stable ordinal until that event contract gains one.
          turn: state.contextCompactions.length + 1,
        };
        // Compaction already reduces the model context (`historyRef`) and the
        // persisted snapshot. Do NOT delete the visible transcript here — that
        // would re-break scrolling history. Only offload oldest entries from
        // memory past the (opt-in) threshold; the full canonical history stays
        // reachable for rewind/fork and for the user paging back.
        const messages = offloadTranscript(state.messages);
        return {
          ...state,
          messages,
          contextTokens: event.afterTokens,
          contextCompactions: [...state.contextCompactions, compaction],
          status: `Context compacted ${event.beforeTokens} → ${event.afterTokens} tokens`,
        };
      }

      case "plan_act_event":
        // Keep plan lifecycle events on the same reducer path regardless of
        // which agent-loop consumer dispatched them.
        return reducer(state, { type: "PLAN_ACT_EVENT", event: event.event });

      case "auto_subagent":
        return {
          ...state,
          status: event.executed
            ? `Auto subagent started (${event.profile}, score=${event.score})`
            : event.shouldDelegate
              ? `Subagent delegation suggested (${event.profile}, score=${event.score})`
              : `No auto delegation (score=${event.score})`,
        };

      case "coordinator_mode":
        return {
          ...state,
          status: event.active
            ? `Orchestration: ${event.profile} (exploration ${event.directExplorationUsed}/${event.maxDirectExploration})`
            : "Orchestration disabled",
        };

      case "thinking_policy":
        return {
          ...state,
          status: `Adaptive thinking: ${event.level} (${event.reasons.join(", ")})`,
        };

      case "tool_start": {
        if (event.call.name === TODO_WRITE_TOOL_NAME) {
          return { ...state, status: "Updating todos…", spinnerMessage: undefined };
        }
        const rawArgs = (event.call.arguments ?? {}) as Record<string, unknown>;
        const args = compactText(JSON.stringify(rawArgs), 120, "…");
        const startedAt = Date.now();
        const paths = toolPaths(rawArgs);
        const card: ChatMessage = {
          kind: "tool_call",
          id: event.call.id,
          name: event.call.name,
          args,
          rawArgs,
          status: "running",
          startedAt,
        };
        const sidebarCard: ToolCardState = {
          id: event.call.id,
          name: event.call.name,
          args,
          status: "running",
          startedAt,
        };
        const step: WorkflowStep = {
          id: event.call.id,
          label: toolLabel(event.call.name, rawArgs),
          status: "running",
        };
        const newMessages: ChatMessage[] = [...state.messages, card];
        const toolRevision = state.toolRevision + 1;
        const baseNext: TuiState = {
          ...state,
          messages: newMessages,
          toolById: { ...state.toolById, [event.call.id]: card },
          toolIndexById: { ...state.toolIndexById, [event.call.id]: newMessages.length - 1 },
          toolRevision,
          toolChange: { id: event.call.id, index: newMessages.length - 1, revision: toolRevision },
          activeToolId: event.call.id,
          steps: [...state.steps.filter((item) => item.id !== step.id), step],
          touchedFiles: [...state.touchedFiles, ...paths.filter((path) => !state.touchedFiles.includes(path))].slice(-50),
          toolCards: [...state.toolCards.filter((item) => item.id !== sidebarCard.id), sidebarCard],
          status: `${event.call.name}...`,
          spinnerMessage: undefined,
        };
        return pruneTranscriptAndDictionaries(baseNext);
      }

      case "tool_end": {
        if (event.call.name === TODO_WRITE_TOOL_NAME) {
          return {
            ...state,
            status: event.result.isError ? "Todo update failed" : "Todos updated",
          };
        }
        // The mode-request tool's own name contains "permission", which the
        // generic status translator maps to "Waiting for permission". Give it
        // dedicated wording so the status row does not claim a tool approval
        // is pending when only a mode switch is.
        if (event.call.name === MODE_REQUEST_TOOL_NAME) {
          const nextState = updateToolMessage(state, event.call.id, (message) => ({
            ...message,
            status: (event.result.isError ? "error" : "done") as ToolState,
            result: resultContent(event.result.content),
            durationMs: Date.now() - message.startedAt,
          }));
          return {
            ...nextState,
            toolCards: state.toolCards.map((card) => card.id === event.call.id
              ? { ...card, status: event.result.isError ? "error" : "done" } satisfies ToolCardState
              : card),
            status: event.result.isError
              ? "Mode request rejected"
              : state.pendingModeRequest
                ? `Mode switch requested: ${state.pendingModeRequest.mode}`
                : "Mode request recorded",
            spinnerMessage: undefined,
          };
        }
        if (event.call.name === "validate_workspace") {
          return {
            ...state,
            status: event.result.isError ? "Post-edit verification failed, repairing" : "Post-edit verification passed",
            spinnerMessage: undefined,
          };
        }
        const now = Date.now();
        const result = resultPreview(event.result.content);
        const transcriptResult = resultContent(event.result.content);
        const nextState = updateToolMessage(state, event.call.id, (message) => ({
          ...message,
          status: (event.result.isError ? "error" : "done") as ToolState,
          result: transcriptResult,
          durationMs: now - message.startedAt,
        }));
        const updatedCards = state.toolCards.map((card) => {
          if (card.id !== event.call.id) return card;
          return {
            ...card,
            status: event.result.isError ? "error" : (event.result.partial ? "partial" : "done"),
            preview: result || undefined,
            durationMs: card.startedAt ? Math.max(0, now - card.startedAt) : undefined,
          } satisfies ToolCardState;
        });
        const updatedSteps = state.steps.map((step) =>
          step.id === event.call.id
            ? { ...step, status: event.result.isError ? ("error" as const) : ("done" as const) }
            : step,
        );
        return {
          ...nextState,
          steps: updatedSteps,
          toolCards: updatedCards,
          status: event.result.isError ? `${event.call.name} failed` : `${event.call.name} completed`,
          spinnerMessage: undefined,
        };
      }

      case "permission_required":
        return {
          ...state,
          pendingPermission: {
            requestId: event.request.id,
            sessionId: event.request.sessionId,
            tool: event.request.tool,
            arguments: event.request.arguments,
            risk: event.request.risk,
          },
          status: `Waiting for permission: ${event.request.tool} (${event.request.risk}) [A allow / D deny / Enter deny / Esc cancel]`,
        };

      case "permission_mode_requested":
        // The model only *asked*; the mode is unchanged until the user accepts.
        // Asking for the mode that is already active would show a card whose
        // only possible outcome is "nothing changes", so it never opens.
        if (state.permissionMode === event.mode) {
          return {
            ...state,
            status: `Already in ${event.mode} mode`,
          };
        }
        return {
          ...state,
          pendingModeRequest: { mode: event.mode, reason: event.reason },
          status: `Mode switch requested: ${event.mode}`,
        };

      case "aborted":
        return {
          ...state,
          busy: false,
          streamingText: "",
          streamingReasoning: "",
          streamingTextParts: [],
          streamingReasoningParts: [],
          streamRetryCommittedText: undefined,
          streamSealPending: undefined,
          turnStartedAt: undefined,
          lastStreamAt: undefined,
          pendingPermission: undefined,
          pendingModeRequest: undefined,
          spinnerMessage: undefined,
          status: "Aborted",
          taskStatus: "cancelled",
          taskDurationMs: taskDuration(state.taskStartedAt),
        };

      case "done": {
        const baseNext: TuiState = {
          ...state,
          busy: false,
          streamingText: "",
          streamingReasoning: "",
          streamingTextParts: [],
          streamingReasoningParts: [],
          streamRetryCommittedText: undefined,
          streamSealPending: undefined,
          turnStartedAt: undefined,
          lastStreamAt: undefined,
          pendingPermission: undefined,
          spinnerMessage: undefined,
          // A mode request outlives the turn on purpose: the model asks, ends
          // its turn, and the card must stay until the user answers A/D.
          status: state.pendingModeRequest
            ? `Mode switch requested: ${state.pendingModeRequest.mode}`
            : "Ready",
          taskStatus: state.taskStatus === "failed" || state.taskStatus === "cancelled" ? state.taskStatus : "completed",
          taskDurationMs: taskDuration(state.taskStartedAt),
        };
        return pruneTranscriptAndDictionaries(baseNext);
      }

      default:
        return state;
    }
}
