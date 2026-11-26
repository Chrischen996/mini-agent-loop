// Pure routing decision for a completed background sub-agent, split out of
// AgentSessionApp.tsx's `getSubagentTools` handler.
//
// The component owns the I/O (claimAutoWake / markAutoWakeDelivered / submit,
// the background-task map, and the pending-prompt queues). This module owns
// the *decision*: given the completion event, the owning session, the current
// TUI state, and the recorded background task, where does the synthetic
// completion prompt go, and what notice (if any) is shown to the user.
//
// Keeping the decision pure lets it be behavior-locked without a React
// renderer (this project has no renderHook/createRoot test infra).

import type { TuiState } from "./state.ts";
import type { SubagentEvent } from "../subagent/types.ts";
import { makeSubagentCompletionPrompt } from "./subagent-prompts.ts";

type SubagentEnd = Extract<SubagentEvent, { type: "subagent_end" }>;

/** The recorded background task that a `subagent_end` maps back to. */
export type BackgroundSubagentRecord = {
  task: string;
  ownerSessionId?: string;
};

export type SubagentCompletionPlan =
  | {
      /** The completion belongs to another session: queue the prompt there.
       *  No local notice is shown. */
      kind: "other-session";
      ownerSessionId: string;
      prompt: string;
    }
  | {
      /** Local session is busy (a turn/permission is in flight): show the
       *  notice and park the prompt in the prompt queue for the next turn. */
      kind: "queue";
      prompt: string;
      notice: { title: string; text: string };
    }
  | {
      /** Local session is idle: show the notice and deliver the prompt now
       *  (the caller then marks the auto-wake delivered and submits). */
      kind: "deliver";
      prompt: string;
      notice: { title: string; text: string };
    };

export type SubagentCompletionInput = {
  event: SubagentEnd;
  /** The background task this completion maps to (undefined when none was
   *  tracked, in which case the caller dispatches the raw event only). */
  background?: BackgroundSubagentRecord;
  /** Resolved owner session (the background record's owner, else current). */
  ownerSessionId: string;
  /** True when `ownerSessionId` differs from the session running this UI. */
  belongsToOtherSession: boolean;
  /** Live TUI state the queue/deliver decision reads. */
  state: Pick<
    TuiState,
    "busy" | "pendingPermission" | "pendingModeRequest" | "phase" | "currentPlan"
  >;
};

/** Human-readable completion status, mirroring the component's wording. */
export function subagentCompletionStatus(event: SubagentEnd): string {
  return event.success
    ? "completed"
    : event.partial
      ? "completed with partial results"
      : "failed";
}

/**
 * Decide where a completed background sub-agent's synthetic prompt is routed
 * and which notice to surface. Pure: no I/O, no React — the caller executes
 * the resulting plan (queueing, submitting, or marking the wake delivered).
 */
export function planSubagentCompletion(input: SubagentCompletionInput): SubagentCompletionPlan {
  const { event, background, ownerSessionId, belongsToOtherSession, state } = input;

  const prompt = makeSubagentCompletionPrompt(
    event.id,
    background?.task ?? "",
    event.result,
    subagentCompletionStatus(event),
    { worktreePath: event.worktreePath, worktreeBranch: event.worktreeBranch },
  );

  if (belongsToOtherSession) {
    return { kind: "other-session", ownerSessionId, prompt };
  }

  const notice = {
    title: "Background sub-agent completed",
    text: [
      `${background?.task ?? ""}: ${subagentCompletionStatus(event)}\nTask ID: ${event.id}`,
      ...(event.worktreePath && event.worktreeBranch
        ? [`Worktree: ${event.worktreePath}\nBranch: ${event.worktreeBranch}`]
        : []),
    ].join("\n"),
  };

  const localBusy =
    state.busy ||
    state.pendingPermission !== undefined ||
    state.pendingModeRequest !== undefined;

  return localBusy ? { kind: "queue", prompt, notice } : { kind: "deliver", prompt, notice };
}

/** Is the owning session currently running a goal loop (used before an
 *  auto-wake claim decides whether to interrupt it)? Mirrors the component
 *  check exactly. */
export function goalLoopActive(
  state: Pick<TuiState, "phase" | "currentPlan">,
): boolean {
  return state.phase === "acting" || state.currentPlan?.status === "executing";
}
