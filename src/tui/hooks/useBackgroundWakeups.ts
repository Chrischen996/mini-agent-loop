// Background-work wakeups for the Ink session view.
//
// Three effects used to live inline in `AgentSessionApp`, all of them about
// "something finished in the background, feed it back into this conversation":
//
// 1. background shell task completion -> notice + completion prompt
// 2. sub-agent completion (in-process event and on-disk registry) -> same
// 3. queued-prompt drain once the current turn is no longer busy
//
// They share the same queue and the same "is the session busy?" gate, so they
// live together here instead of being three separate blocks in the component.

import { useEffect, type Dispatch, type MutableRefObject } from "react";
import { stat } from "node:fs/promises";
import type { BgTaskManager, BgTaskSummary } from "../../bg-tasks/manager.js";
import type { SubagentTaskRegistry } from "../../subagent/task-registry.ts";
import {
  COMPLETION_OUTPUT_LIMIT_BYTES,
  autoWakeEnabled,
  makeBgTaskCompletionPrompt,
  makeSubagentCompletionPrompt,
  subagentWakeId,
} from "../subagent-prompts.ts";
import type { TuiAction, TuiState } from "../state.ts";

export type BackgroundWakeupsOptions = {
  /** False for mounted-but-hidden sessions; they must not print or submit. */
  active: boolean;
  conversationId: string;
  dispatch: Dispatch<TuiAction>;
  stateRef: MutableRefObject<TuiState>;
  getBgManager: () => BgTaskManager | null;
  refreshBgTaskCount: () => Promise<void>;
  subagentTaskRegistry: SubagentTaskRegistry;
  /** Prompts waiting for the current turn to finish. */
  promptQueueRef: MutableRefObject<string[]>;
  /** Completion prompts that belong to this session but arrived while busy. */
  pendingSubagentPromptsRef: MutableRefObject<Map<string, string[]>>;
  setQueuedCount: (count: number) => void;
  /** Submit the next prompt (identity-stable; the component stores it in a ref). */
  handleSubmit: (text: string) => Promise<void>;
  handleSubmitRef: MutableRefObject<(text: string) => Promise<void>>;
  /** Busy/pending state read at call time, not at render time. */
  busy: boolean;
  pendingPermission: boolean;
  /** Plan-Act progress, used to decide whether a goal loop is still running. */
  planPhase: string;
  planStatus: string | undefined;
};

/**
 * Wire background completions back into the conversation.
 *
 * Ordering note: the queue drain runs *after* the completion effects in the
 * original component, and `handleSubmit` is read through a ref so a new render
 * never restarts an in-flight drain.
 */
export function useBackgroundWakeups(options: BackgroundWakeupsOptions): void {
  const {
    active,
    conversationId,
    dispatch,
    stateRef,
    getBgManager,
    refreshBgTaskCount,
    subagentTaskRegistry,
    promptQueueRef,
    pendingSubagentPromptsRef,
    setQueuedCount,
    handleSubmit,
    handleSubmitRef,
    busy,
    pendingPermission,
    planPhase,
    planStatus,
  } = options;

  // ── 1. background shell task completion ──────────────────────────────────
  useEffect(() => {
    const manager = getBgManager();
    if (!manager) return;
    const onCompletion = (task: BgTaskSummary) => {
      const wasActivelyWaited = manager.isActivelyWaited(task.taskId, conversationId)
        || manager.wasWaitedToCompletion(task.taskId, conversationId);
      void (async () => {
        let output = "";
        let outputOmitted = false;
        try {
          const size = (await stat(task.logPath)).size;
          const offset = Math.max(0, size - COMPLETION_OUTPUT_LIMIT_BYTES);
          if (size > 0) {
            const chunk = await manager.logs(task.taskId, offset, Math.max(4, size - offset));
            output = chunk.text.trimEnd();
            outputOmitted = offset > 0;
          }
        } catch {
          // Keep the completion notice useful even if its output log disappeared.
        }

        const exit = task.exitCode === 0 || task.exitCode === null || task.exitCode === undefined
          ? ""
          : ` (exit ${task.exitCode})`;
        const outputLabel = outputOmitted ? "Output (final 4 kB)" : "Output";
        const outputText = output || "(no output)";
        dispatch({
          type: "ADD_NOTICE",
          title: "Background task completed",
          text: `${task.name}: ${task.status}${exit}\nTask ID: ${task.taskId}\n${outputLabel}:\n${outputText}`,
        });
        void refreshBgTaskCount();

        if (wasActivelyWaited) return;
        const completionPrompt = makeBgTaskCompletionPrompt({
          taskName: task.name,
          taskId: task.taskId,
          status: task.status,
          exit,
          outputLabel,
          outputText,
        });
        if (stateRef.current.busy || stateRef.current.pendingPermission) {
          promptQueueRef.current.push(completionPrompt);
          setQueuedCount(promptQueueRef.current.length);
        } else {
          void handleSubmitRef.current(completionPrompt);
        }
      })().catch((error) => {
        dispatch({
          type: "ADD_NOTICE",
          title: "Background task notification failed",
          text: error instanceof Error ? error.message : String(error),
        });
      });
    };
    const unsubscribe = manager.onCompletion(onCompletion, conversationId, () => active);
    return unsubscribe;
  }, [active, conversationId, dispatch, getBgManager, refreshBgTaskCount, stateRef, promptQueueRef, setQueuedCount, handleSubmitRef]);

  // ── 2. sub-agent completion (event + on-disk registry) ────────────────────
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let wakeRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    const drainPendingWakeups = () => (async () => {
      const pending = await subagentTaskRegistry.pendingWakeups(conversationId);
      for (const record of pending) {
        const goalLoopActive = stateRef.current.phase === "acting" || stateRef.current.currentPlan?.status === "executing";
        const shouldWake = await subagentTaskRegistry.claimAutoWake(record.taskId, conversationId, autoWakeEnabled(), goalLoopActive);
        if (!shouldWake) continue;
        const status = record.status === "failed" ? "failed" : record.partial ? "completed with partial results" : "completed";
        const prompt = makeSubagentCompletionPrompt(record.taskId, record.task, record.result ?? record.error ?? "(no output)", status, {
          worktreePath: record.worktreePath,
          worktreeBranch: record.worktreeBranch,
        });
        if (cancelled) {
          const queued = pendingSubagentPromptsRef.current.get(conversationId) ?? [];
          queued.push(prompt);
          pendingSubagentPromptsRef.current.set(conversationId, queued);
          continue;
        }
        dispatch({
          type: "ADD_NOTICE",
          title: "Background sub-agent completed",
          text: [
            `${record.task}: ${status}\nTask ID: ${record.taskId}`,
            ...(record.worktreePath && record.worktreeBranch
              ? [`Worktree: ${record.worktreePath}\nBranch: ${record.worktreeBranch}`]
              : []),
          ].join("\n"),
        });
        if (stateRef.current.busy || stateRef.current.pendingPermission) {
          promptQueueRef.current.push(prompt);
          setQueuedCount(promptQueueRef.current.length);
        } else {
          await subagentTaskRegistry.markAutoWakeDelivered(record.taskId, conversationId);
          void handleSubmitRef.current(prompt);
        }
      }
    })().catch((error) => {
      if (cancelled) return;
      dispatch({
        type: "ADD_NOTICE",
        title: "Sub-agent completion recovery failed",
        text: error instanceof Error ? error.message : String(error),
      });
    });
    void drainPendingWakeups();
    // Detached workers (including /goal --bg) finish in another process, so
    // registry disk changes are the completion signal. In-process onChange
    // cannot see a different process, so poll until the wake is claimed, then
    // rely on onChange for local subagent events again.
    const unsubscribe = subagentTaskRegistry.onChange(() => void drainPendingWakeups());
    const hasPendingGoalWake = async (): Promise<boolean> =>
      (await subagentTaskRegistry.pendingWakeups(conversationId)).length > 0;
    wakeRefreshTimer = setTimeout(() => {
      void hasPendingGoalWake().then((pending) => {
        if (pending) void drainPendingWakeups();
      }).catch(() => undefined);
    }, 1_000);
    return () => {
      cancelled = true;
      unsubscribe();
      if (wakeRefreshTimer !== undefined) clearTimeout(wakeRefreshTimer);
    };
  }, [active, conversationId, dispatch, planStatus, planPhase, subagentTaskRegistry, stateRef, promptQueueRef, pendingSubagentPromptsRef, setQueuedCount, handleSubmitRef]);

  // ── 3. drain the prompt queue once the turn finishes ─────────────────────
  useEffect(() => {
    if (busy || pendingPermission) return;
    void (async () => {
      while (!stateRef.current.busy && !stateRef.current.pendingPermission) {
        let next = promptQueueRef.current.shift();
        if (!next) {
          const pending = pendingSubagentPromptsRef.current.get(conversationId);
          next = pending?.shift();
          if (pending && pending.length === 0) pendingSubagentPromptsRef.current.delete(conversationId);
        }
        if (!next) break;
        setQueuedCount(promptQueueRef.current.length);
        const wakeId = subagentWakeId(next);
        if (wakeId && !(await subagentTaskRegistry.markAutoWakeDelivered(wakeId, conversationId))) continue;
        void handleSubmit(next);
        break;
      }
    })().catch((error) => {
      dispatch({
        type: "ADD_NOTICE",
        title: "Queued prompt handling failed",
        text: error instanceof Error ? error.message : String(error),
      });
    });
  }, [busy, pendingPermission, handleSubmit, conversationId, subagentTaskRegistry, stateRef, promptQueueRef, pendingSubagentPromptsRef, setQueuedCount, dispatch]);
}
