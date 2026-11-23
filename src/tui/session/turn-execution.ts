// One agent turn for the Ink session view.
//
// `handleSubmit` used to inline this whole block: image materialization, the
// user-message dispatch, the auto-continue loop, abort/timeout handling, and
// the plan/exec capture finalizers. It now lives here so the component only
// wires inputs and renders state.
//
// Invariants (do not weaken):
// - every tool call still gets a result (the loop owns that), and `maxTurns`
//   stays a hard stop enforced by `runAgentTurn`;
// - `streamBuffer.finish(runId)` runs on every exit path before the next turn;
// - the permission turn is always closed in `finally`.

import type { Dispatch, MutableRefObject } from "react";
import {
  MaxTurnsExceededError,
  runAgentTurn,
  type AgentRuntimeRef,
  type LoopEvent,
} from "../../loop.ts";
import { LlmTimeoutError } from "../../llm/retry.ts";
import type { LlmConfig } from "../../llm/index.ts";
import {
  buildIntenseLlm,
  parseThinkingCommandMode,
  parseThinkingIntensityPrompt,
  withThinkingLevel,
} from "../../think-intensity.ts";
import { createVisionPreprocessor } from "../../preprocessors/index.ts";
import { resolveToolProvider, type ToolProvider } from "../../tools/types.ts";
import type { AgentMessage, ImagePart, MessageContent } from "../../types.ts";
import {
  PermissionModeChangedError,
  type PermissionManager,
  type PermissionTurnContext,
} from "../../permissions.ts";
import { isBackgroundGoalActive, type GoalSessionContext } from "../../goal/index.ts";
import { isTuiFeatureEnabled } from "../execution-policy.ts";
import { finalizeExecCapture, finalizePlanCapture, type PlanOverrideResult } from "../plan-commands.ts";
import { imageAttachmentToPart } from "../image-attachments.ts";
import { defaultSkillRegistry } from "../../skills/index.ts";
import { formatLlmTimeoutMessage } from "../turn-messages.ts";
import type { TurnEventBuffer } from "../stream-buffer.ts";
import type { ImageAttachment, TuiAction, TuiState } from "../state.ts";
import type { RuntimeExecutionContext } from "../../runtime/policy-types.ts";
import type { SessionManager } from "../../session-manager.ts";
import type { SubagentTaskRegistry } from "../../subagent/task-registry.ts";
import type { ThinkingMode } from "../../thinking-policy.ts";

/** Message used when an auto-continue resumes a truncated turn. */
const CONTINUATION_PROMPT = "Continue the previous work";

/** Hard cap on automatic maxTurns continuations per submission. */
const MAX_AUTO_CONTINUES = 5;

/** Tools whose wait can be interrupted by "send now". */
export const SEND_NOW_WAIT_TOOLS = new Set([
  "bg_wait",
  "subagent_wait",
  "subagent",
  "subagent_batch",
  "search_orchestrate",
]);

export type TurnExecutionContext = {
  /** Raw prompt text as typed (already trimmed by the caller). */
  trimmed: string;
  /** Plan/exec override from the slash-command cascade, when present. */
  planTurnOverride: PlanOverrideResult | null | undefined;
  cwd: string;
  projectCwd: string;
  conversationId: string;
  state: TuiState;
  dispatch: Dispatch<TuiAction>;
  setInput: (value: string) => void;
  llm: LlmConfig;
  llmRef: MutableRefObject<LlmConfig>;
  setLlm: (config: LlmConfig) => void;
  historyRef: MutableRefObject<AgentMessage[]>;
  activeTodosRef: MutableRefObject<TuiState["todoItems"]>;
  pendingImagesRef: MutableRefObject<ImageAttachment[]>;
  skillNamesRef: MutableRefObject<string[]>;
  thinkingPolicyModeRef: MutableRefObject<ThinkingMode>;
  planCaptureRef: MutableRefObject<{ prompt: string } | null>;
  execCaptureRef: MutableRefObject<{ mode: "run" | "retry" } | null>;
  permissionTurnRef: MutableRefObject<PermissionTurnContext | null>;
  abortRef: MutableRefObject<AbortController>;
  streamBufferRef: MutableRefObject<TurnEventBuffer | null>;
  stateRef: MutableRefObject<TuiState>;
  sendNowWaitToolIdsRef: MutableRefObject<Set<string>>;
  agentToolsRef: MutableRefObject<ToolProvider>;
  subagentRuntimeRef: MutableRefObject<AgentRuntimeRef>;
  subagentTaskRegistry: SubagentTaskRegistry;
  autoSubagent: ReturnType<typeof import("../../subagent/index.ts").loadAutoSubagentOptionsFromEnv>;
  vision: ReturnType<typeof import("../../preprocessors/index.ts").loadVisionConfigFromEnv>;
  globalTokenBudget: ReturnType<typeof import("../../runtime/limits.ts").loadGlobalTokenBudgetFromEnv>;
  goalConfig: ReturnType<typeof import("../../goal/index.ts").resolveGoalConfig>;
  getGoalSession: () => GoalSessionContext | null;
  getPermissionManager: () => PermissionManager;
  getSessionManager: () => SessionManager;
  refreshBgTaskCount: () => Promise<void>;
  persistSessionSnapshot: (messages: AgentMessage[], modelConfig?: LlmConfig) => Promise<void>;
  resolveAtRefsRef: (text: string, permissionTurn: PermissionTurnContext) => Promise<MessageContent>;
  setSendableWaitWaiting: (waiting: boolean) => void;
  permissionSessionId: string;
  /** In-memory history cap applied after the turn completes. */
  maxInMemoryMessages: number;
  defaultImagePrompt: string;
  /** Tool list factory for the subagent tools (parent model aware). */
  getSubagentTools: (parentLlm: LlmConfig) => import("../../tools/types.ts").Tool[];
  /** Session snapshot fields written to disk at turn start. */
  sessionSnapshotFields: () => Record<string, unknown>;
};

/** Result of one submission, used by tests and callers that need the history. */
export type TurnExecutionResult = {
  /** True when a turn actually ran (false when the input was empty). */
  ran: boolean;
  /** True when the agent turn finished without an error. */
  succeeded: boolean;
};

export async function runSessionTurn(
  ctx: TurnExecutionContext,
): Promise<TurnExecutionResult> {
  const {
    trimmed,
    planTurnOverride,
    cwd,
    projectCwd,
    conversationId,
    state,
    dispatch,
    setInput,
    llm,
    llmRef,
    setLlm,
    historyRef,
    activeTodosRef,
    pendingImagesRef,
    skillNamesRef,
    thinkingPolicyModeRef,
    planCaptureRef,
    execCaptureRef,
    permissionTurnRef,
    abortRef,
    streamBufferRef,
    stateRef,
    sendNowWaitToolIdsRef,
    agentToolsRef,
    subagentRuntimeRef,
    subagentTaskRegistry,
    autoSubagent,
    vision,
    globalTokenBudget,
    goalConfig,
    getGoalSession,
    getPermissionManager,
    getSessionManager,
    refreshBgTaskCount,
    persistSessionSnapshot,
    resolveAtRefsRef,
    setSendableWaitWaiting,
    permissionSessionId,
    maxInMemoryMessages,
    defaultImagePrompt,
    getSubagentTools,
    sessionSnapshotFields,
  } = ctx;

  const pendingImgs = planTurnOverride ? [] : [...pendingImagesRef.current];
  if (!planTurnOverride && !trimmed && pendingImgs.length === 0) {
    setInput("");
    return { ran: false, succeeded: false };
  }
  const prompt = planTurnOverride?.prompt ?? (trimmed || defaultImagePrompt);
  const parsedThinking = planTurnOverride
    ? { intensity: undefined as undefined }
    : parseThinkingIntensityPrompt(prompt);
  let turnLlm = parsedThinking.intensity
    ? buildIntenseLlm(llm, parsedThinking.intensity)
    : llm;
  if (parsedThinking.intensity) {
    llmRef.current = turnLlm;
    setLlm(turnLlm);
  }
  let imageParts: ImagePart[];
  try {
    imageParts = await Promise.all(pendingImgs.map(imageAttachmentToPart));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    dispatch({ type: "ATTACHMENT_ERROR", message: `Unable to read image for sending: ${detail}` });
    return { ran: false, succeeded: false };
  }

  setInput("");
  pendingImagesRef.current = [];
  if (state.pendingImages.length > 0) dispatch({ type: "CLEAR_PENDING_IMAGES" });
  sendNowWaitToolIdsRef.current.clear();
  setSendableWaitWaiting(false);
  abortRef.current = new AbortController();
  if (goalConfig.enabled) getGoalSession()?.runtime.beginTurn();
  const permissionManager = getPermissionManager();
  if (planTurnOverride?.forceMode && permissionManager.getMode() !== planTurnOverride.forceMode) {
    permissionManager.setMode(planTurnOverride.forceMode);
    dispatch({ type: "SET_PERMISSION_MODE", mode: planTurnOverride.forceMode });
  }
  const permissionTurn = permissionManager.beginTurn(
    permissionSessionId,
    (request) => dispatch({ type: "LOOP_EVENT", event: { type: "permission_required", request } }),
    abortRef.current.signal,
  );
  permissionTurnRef.current = permissionTurn;
  // Collapse multi-line pastes into a summary for display, but keep full text for model context.
  const displaySource = planTurnOverride?.displayText ?? prompt;
  const normalizedPrompt = displaySource.replace(/\r\n/g, '\n');
  const isMultiLine = !planTurnOverride && normalizedPrompt.includes('\n');
  const lineCount = isMultiLine ? normalizedPrompt.split('\n').length : 1;
  // Count graphemes properly (emoji = 1 char, not 2 UTF-16 units)
  const charCount = [...normalizedPrompt].length;
  const displayText = planTurnOverride
    ? planTurnOverride.displayText
    : isMultiLine
      ? `[Collapsed ${lineCount} lines / ${charCount} characters]`
      : undefined;
  dispatch({
    type: "USER_MESSAGE",
    text: planTurnOverride ? planTurnOverride.displayText : prompt,
    ...(displayText !== undefined && !planTurnOverride ? { displayText } : {}),
    images: pendingImgs,
  });

  const streamBuffer = streamBufferRef.current!;
  const runId = streamBuffer.start();
  let autoContinueCount = 0;
  let currentUserText = planTurnOverride
    ? prompt
    : prompt.replace(/@\S+/g, "").replace(/\s{2,}/g, " ").trim();
  const thinkingMode = planTurnOverride
    ? thinkingPolicyModeRef.current
    : parsedThinking.intensity
      ? "fixed"
      : parseThinkingCommandMode(prompt) ?? thinkingPolicyModeRef.current;
  thinkingPolicyModeRef.current = thinkingMode;
  let turnSucceeded = false;
  let turnErrorMessage: string | undefined;

  const onLoopEvent = (event: LoopEvent) => {
    if (event.type === "tool_start" && SEND_NOW_WAIT_TOOLS.has(event.call.name)) {
      sendNowWaitToolIdsRef.current.add(event.call.id);
      setSendableWaitWaiting(true);
    } else if (event.type === "tool_end" && sendNowWaitToolIdsRef.current.delete(event.call.id)) {
      setSendableWaitWaiting(sendNowWaitToolIdsRef.current.size > 0);
    }

    if (event.type === "thinking_policy") {
      turnLlm = withThinkingLevel(turnLlm, event.level);
      llmRef.current = turnLlm;
      setLlm(turnLlm);
    } else if (event.type === "todo_updated") {
      activeTodosRef.current = event.todos;
    } else if (event.type === "auto_subagent") {
      const status = event.executed
        ? `Auto subagent started (${event.profile}, score=${event.score})`
        : event.shouldDelegate
          ? `Subagent delegation suggested (${event.profile}, score=${event.score})`
          : `Automatic delegation skipped (score=${event.score})`;
      dispatch({ type: "SET_STATUS", status });
    } else if (event.type === "coordinator_mode") {
      dispatch({
        type: "SET_STATUS",
        status: event.active
          ? `Orchestration: ${event.profile} (exploration ${event.directExplorationUsed}/${event.maxDirectExploration})`
          : "Orchestration disabled",
      });
    } else if (event.type === "tool_start" && event.call.name.startsWith("bg_")) {
      // A bg_* call from the agent starts the badge without requiring the
      // user to run /bg-tasks first.
      void refreshBgTaskCount();
    }
    streamBuffer.handle(runId, event);
  };

  try {
    let currentUserContent = planTurnOverride
      ? prompt
      : await resolveAtRefsRef(prompt, permissionTurn);
    if (imageParts.length > 0) {
      const contentParts = typeof currentUserContent === "string"
        ? [{ type: "text" as const, text: currentUserContent }]
        : currentUserContent;
      currentUserContent = [...contentParts, ...imageParts];
    }

    try {
      await getSessionManager().saveTurnStart({
        ...sessionSnapshotFields(),
        messages: historyRef.current,
        content: currentUserContent,
      });
    } catch (error) {
      dispatch({
        type: "ADD_NOTICE",
        title: "Session save failed",
        text: error instanceof Error ? error.message : String(error),
      });
    }

    // Background-goal mutex: while a detached worker owns the goal
    // (`/goal ... --bg`), the foreground loop must not attach goalRuntime —
    // the worker is the single steerer/accountant. Resolved once per
    // submission; goal tools stay available so /goal status keeps working.
    const goalSessionForTurn = goalConfig.enabled ? getGoalSession() : null;
    const backgroundOwnsGoal = goalSessionForTurn
      ? await isBackgroundGoalActive(goalSessionForTurn.store, conversationId, subagentTaskRegistry).catch(() => false)
      : false;

    // Auto-continue loop: re-invoke runAgentTurn when maxTurns is exceeded.
    while (true) {
      try {
        historyRef.current = await runAgentTurn(historyRef.current, currentUserText, {
          llm: { ...turnLlm, sessionId: conversationId },
          tools: () => [
            ...resolveToolProvider(agentToolsRef.current),
            ...getSubagentTools(turnLlm),
            ...(goalSessionForTurn ? goalSessionForTurn.tools : []),
          ],
          ...(goalSessionForTurn && !backgroundOwnsGoal ? { goalRuntime: goalSessionForTurn.runtime } : {}),
          autoSubagent,
          preprocessors: vision ? [createVisionPreprocessor(vision)] : [],
          signal: abortRef.current.signal,
          userContent: currentUserContent,
          permissionTurn,
          sessionPhase: stateRef.current.currentPlan ? stateRef.current.phase : undefined,
          runtimeContext: {
            sessionId: conversationId,
            workspaceId: projectCwd,
            cwd,
          } satisfies RuntimeExecutionContext,
          globalTokenBudget,
          autoValidate: isTuiFeatureEnabled(process.env.MINI_AGENT_AUTO_VALIDATE),
          validationWorkspace: cwd,
          autoCheckpoint: isTuiFeatureEnabled(process.env.MINI_AGENT_AUTO_CHECKPOINT),
          thinkingMode,
          runtimeRef: subagentRuntimeRef.current,
          skillNames: skillNamesRef.current,
          skillRegistry: defaultSkillRegistry,
          onEvent: onLoopEvent,
          onCheckpoint: async (checkpoint) => {
            historyRef.current = checkpoint.messages;
            await persistSessionSnapshot(checkpoint.messages);
          },
        });
        streamBuffer.finish(runId);
        turnSucceeded = true;
        break;
      } catch (err) {
        if (err instanceof MaxTurnsExceededError) {
          historyRef.current = err.messages;
          autoContinueCount++;
          if (autoContinueCount >= MAX_AUTO_CONTINUES || permissionTurn.signal.aborted) {
            streamBuffer.finish(runId);
            turnErrorMessage = permissionTurn.signal.aborted
              ? "aborted"
              : `Reached the auto-continue limit (${MAX_AUTO_CONTINUES} runs)`;
            if (permissionTurn.signal.aborted) {
              const reason = permissionTurn.signal.reason;
              dispatch({
                type: "LOOP_EVENT",
                event: reason instanceof PermissionModeChangedError
                  ? {
                      type: "aborted",
                      messages: historyRef.current,
                      reason: "permission_mode_changed",
                      previousMode: reason.previousMode,
                      permissionMode: reason.mode,
                    }
                  : { type: "aborted", messages: historyRef.current },
              });
            } else {
              dispatch({ type: "LOOP_EVENT", event: { type: "error", message: turnErrorMessage } });
            }
            break;
          }
          currentUserText = CONTINUATION_PROMPT;
          currentUserContent = currentUserText;
          dispatch({ type: "AUTO_CONTINUE", count: autoContinueCount, max: MAX_AUTO_CONTINUES });
          continue;
        }
        if (err instanceof LlmTimeoutError && err.messages) {
          // Timeout with partial content: save the partial history so the next
          // turn starts from the known state instead of losing the streamed output.
          historyRef.current = err.messages;
          streamBuffer.finish(runId);
          turnErrorMessage = formatLlmTimeoutMessage(err);
          dispatch({ type: "LOOP_EVENT", event: { type: "error", message: turnErrorMessage } });
          break;
        }
        throw err;
      }
    }
  } catch (err) {
    streamBuffer.finish(runId);
    turnErrorMessage = err instanceof Error ? err.message : String(err);
    if (err instanceof PermissionModeChangedError || permissionTurn.signal.aborted) {
      const reason = permissionTurn.signal.reason;
      dispatch({
        type: "LOOP_EVENT",
        event: reason instanceof PermissionModeChangedError
          ? {
              type: "aborted",
              messages: historyRef.current,
              reason: "permission_mode_changed",
              previousMode: reason.previousMode,
              permissionMode: reason.mode,
            }
          : { type: "aborted", messages: historyRef.current },
      });
    } else {
      dispatch({ type: "LOOP_EVENT", event: { type: "error", message: turnErrorMessage } });
    }
  } finally {
    sendNowWaitToolIdsRef.current.clear();
    setSendableWaitWaiting(false);
    if (permissionTurnRef.current === permissionTurn) permissionTurnRef.current = null;
    permissionTurn.close();

    // Restore permission mode after plan execution turns.
    if (planTurnOverride?.restoreMode !== undefined) {
      const restore = planTurnOverride.restoreMode;
      if (permissionManager.getMode() !== restore) {
        permissionManager.setMode(restore);
        dispatch({ type: "SET_PERMISSION_MODE", mode: restore });
      }
    }

    await finalizePlanCapture({
      cwd,
      planCaptureRef,
      history: historyRef.current,
      succeeded: turnSucceeded,
      dispatch,
    });
    await finalizeExecCapture({
      cwd,
      execCaptureRef,
      history: historyRef.current,
      succeeded: turnSucceeded,
      errorMessage: turnErrorMessage,
      dispatch,
    });
    await persistSessionSnapshot(historyRef.current);
    // Write back the trimmed in-memory history so the next turn starts from a
    // bounded array instead of the pre-trim reference, capping peak allocation
    // between LLM compaction cycles.
    if (historyRef.current.length > maxInMemoryMessages) {
      historyRef.current = historyRef.current.slice(-maxInMemoryMessages);
    }
  }

  return { ran: true, succeeded: turnSucceeded };
}
