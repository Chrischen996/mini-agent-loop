// Owns the mutable background-task map and the I/O orchestration for routing
// background sub-agent events, split out of AgentSessionApp.tsx.
//
// The React component closed over 21 variables in its `onSubagentEvent`
// handler (the background map, refs to live state/conversation, dispatch,
// the two prompt queues, the registry, the submit callback, and a status
// setter). That is exactly the kind of wide closure this refactor targets:
// the decision lives in the pure `planSubagentCompletion` (see
// subagent-event-route.ts), and this class owns the one piece of mutable
// state that was tangled with it — the id->background-task map — plus the
// side-effect ordering (claim auto-wake, then queue or deliver).
//
// All deps are stable refs / setters, so the component builds the router
// once (useLazyRef) and its `onSubagentEvent` collapses to `router.handle(e)`.

import type { TuiAction, TuiState } from "./state.ts";
import type { SubagentEvent } from "../subagent/types.ts";
import type { SubagentTaskRegistry } from "../subagent/task-registry.ts";
import { autoWakeEnabled } from "./subagent-prompts.ts";
import { goalLoopActive, planSubagentCompletion, type BackgroundSubagentRecord } from "./subagent-event-route.ts";

type Registry = Pick<SubagentTaskRegistry, "claimAutoWake" | "markAutoWakeDelivered">;

export type SubagentEventRouterDeps = {
  /** The session id this UI is rendering (live value). */
  conversationId: () => string;
  /** Live TUI state (reads `stateRef.current`). */
  getState: () => TuiState;
  /** Dispatch to the TUI reducer. */
  dispatch: (action: TuiAction) => void;
  /** Auto-wake ledger / delivery tracker. */
  registry: Registry;
  /** Cross-session completion-prompt queue (mutable map, shared by ref). */
  pendingSubagentPrompts: Map<string, string[]>;
  /** Local-session prompt queue (mutable array, shared by ref). */
  promptQueue: string[];
  /** Keep the queued-count badge in sync with the local prompt queue. */
  setQueuedCount: (count: number) => void;
  /** Deliver a completion prompt into the local session now. */
  submitPrompt: (text: string) => Promise<void>;
};

/**
 * Routes background sub-agent events into the owning session. Holds the
 * background-task map so a completion can be matched back to the task that
 * produced it. The pure decision (where the prompt goes + which notice) is
 * delegated to `planSubagentCompletion`.
 */
export class SubagentEventRouter {
  private readonly background = new Map<string, BackgroundSubagentRecord>();
  private readonly deps: SubagentEventRouterDeps;

  constructor(deps: SubagentEventRouterDeps) {
    this.deps = deps;
  }

  /** Entry point wired to `getSubagentTools({ onSubagentEvent })`. */
  handle(event: SubagentEvent): void {
    const { conversationId, getState, dispatch, registry } = this.deps;
    const me = conversationId();

    if (event.type === "subagent_backgrounded") {
      this.background.set(event.id, {
        task: event.task,
        ...(event.ownerSessionId ? { ownerSessionId: event.ownerSessionId } : {}),
      });
      return;
    }
    const background = this.background.get(event.id);
    const ownerSessionId = background?.ownerSessionId ?? me;
    const belongsToOtherSession = ownerSessionId !== me;
    if (event.type !== "subagent_end") {
      if (!belongsToOtherSession) dispatch({ type: "SUBAGENT_EVENT", event });
      return;
    }
    if (!background) {
      dispatch({ type: "SUBAGENT_EVENT", event });
      return;
    }
    this.background.delete(event.id);

    if (!belongsToOtherSession) dispatch({ type: "SUBAGENT_EVENT", event });

    void (async () => {
      const shouldWake = await registry.claimAutoWake(event.id, ownerSessionId, autoWakeEnabled(), goalLoopActive(getState()));
      if (!shouldWake) return;
      // The queue/deliver decision reads live state AFTER the claim (the
      // original read `stateRef.current` post-await); keep that timing.
      const plan = planSubagentCompletion({
        event,
        background,
        ownerSessionId,
        belongsToOtherSession,
        state: getState(),
      });
      if (plan.kind === "other-session") {
        const queued = this.deps.pendingSubagentPrompts.get(ownerSessionId) ?? [];
        queued.push(plan.prompt);
        this.deps.pendingSubagentPrompts.set(ownerSessionId, queued);
        return;
      }
      dispatch({
        type: "ADD_NOTICE",
        title: plan.notice.title,
        text: plan.notice.text,
      });
      if (plan.kind === "queue") {
        this.deps.promptQueue.push(plan.prompt);
        this.deps.setQueuedCount(this.deps.promptQueue.length);
      } else {
        await registry.markAutoWakeDelivered(event.id, ownerSessionId);
        void this.deps.submitPrompt(plan.prompt);
      }
    })().catch((error) => {
      dispatch({
        type: "ADD_NOTICE",
        title: "Sub-agent completion handling failed",
        text: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Drop every tracked background task (session switch / unmount). */
  clear(): void {
    this.background.clear();
  }
}
