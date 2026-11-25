// Turn-lifecycle projections for the Ink session state.
//
// Split out of `state.ts`: starting a user turn, continuing it, auto-
// continuing it and cancelling it all reshuffle the same streaming/task
// fields in near-identical shapes, so they live together here. The main
// reducer delegates via the `reduce*` functions below, mirroring the
// `loop-events.ts` / `subagent-events.ts` splits.

import {
  pruneTranscriptAndDictionaries,
  taskDuration,
  type ChatMessage,
  type TuiAction,
  type TuiState
} from "../state.ts";

type UserMessageAction = Extract<TuiAction, { type: "USER_MESSAGE" }>;
type AutoContinueAction = Extract<TuiAction, { type: "AUTO_CONTINUE" }>;

export function reduceUserMessage(state: TuiState, action: UserMessageAction): TuiState {
  const appendedMsg: ChatMessage = {
    kind: "user",
    text: action.text,
    ...(action.displayText !== undefined ? { displayText: action.displayText } : {}),
    ...(action.images?.length ? { images: action.images } : {}),
  };
  const baseNext: TuiState = {
    ...state,
    messages: [...state.messages, appendedMsg],
    goal: state.goal || action.text,
    taskTitle: action.text,
    taskStatus: "running",
    taskStartedAt: Date.now(),
    taskDurationMs: undefined,
    taskTokens: 0,
    busy: true,
    status: "Thinking…",
    streamingText: "",
    streamingReasoning: "",
    streamingTextParts: [],
    streamingReasoningParts: [],
    streamRetryCommittedText: undefined,
    streamSealPending: undefined,
    turnStartedAt: Date.now(),
    lastStreamAt: undefined,
    spinnerMessage: undefined,
    autoContinueCount: 0,
    // New user turns always re-pin the feed to the latest content.
    scrollOffset: 0,
  };
  return pruneTranscriptAndDictionaries(baseNext);
}

export function reduceContinueTurn(state: TuiState): TuiState {
  return {
    ...state,
    busy: true,
    taskStatus: "running",
    taskStartedAt: Date.now(),
    taskDurationMs: undefined,
    turnStartedAt: Date.now(),
    streamingText: "",
    streamingReasoning: "",
    streamingTextParts: [],
    streamingReasoningParts: [],
    streamRetryCommittedText: undefined,
    streamSealPending: undefined,
    lastStreamAt: undefined,
    pendingPermission: undefined,
    spinnerMessage: undefined,
    autoContinueCount: 0,
    status: "Continuing…",
    scrollOffset: 0,
  };
}

export function reduceAutoContinue(state: TuiState, action: AutoContinueAction): TuiState {
  const baseNext: TuiState = {
    ...state,
    busy: true,
    streamingText: "",
    streamingReasoning: "",
    streamingTextParts: [],
    streamingReasoningParts: [],
    streamRetryCommittedText: undefined,
    streamSealPending: undefined,
    lastStreamAt: undefined,
    autoContinueCount: action.count,
    status: `Continuing… (${action.count}/${action.max})`,
  };
  return pruneTranscriptAndDictionaries(baseNext);
}

export function reduceCancelGeneration(state: TuiState): TuiState {
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
    spinnerMessage: undefined,
    status: "Generation cancelled (ESC)",
    taskStatus: "cancelled",
    taskDurationMs: taskDuration(state.taskStartedAt),
  };
}
