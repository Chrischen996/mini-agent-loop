import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { ChatStreamState, type ChatItem, type StreamPhase } from "../lib/event-adapter.ts";
import { readNdjson } from "../lib/stream.ts";
import { runStopText } from "../lib/run-state.ts";
import type { ContinueRunRequest, PlanSummary, WireEvent } from "../types/api.ts";
import type { LoadingActivity } from "../lib/loading.ts";

/**
 * Streaming chat for the active session (doc 1.md §7.3).
 *
 * Isolation rule: while a session's stream is in flight, its events are only
 * applied while that session is still the active one. Switching sessions never
 * destroys the backend task; it just stops routing its events locally, and the
 * next activation reloads the persisted history.
 *
 * Multi-turn rule: each send seeds the stream state from the current
 * conversation (itemsRef) so earlier turns are never wiped. The user message
 * itself is rendered from the backend's first NDJSON frame (`user` event),
 * which is the source of truth - echoing it locally as well would render it
 * twice.
 */
export function useAgentStream(activeId: string | null) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [phase, setPhase] = useState<StreamPhase>("idle");
  const [streaming, setStreaming] = useState(false);
  const [activity, setActivity] = useState<LoadingActivity | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [currentPlan, setCurrentPlan] = useState<PlanSummary | null>(null);
  const activeIdRef = useRef(activeId);
  const controllers = useRef(new Map<string, AbortController>());
  // Mirrors `items` so send() can seed the next stream with the current
  // conversation without re-deriving it or wiping multi-turn history.
  const itemsRef = useRef<ChatItem[]>([]);

  const commitItems = useCallback((next: ChatItem[]): void => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // (Re)load persisted history whenever the active session changes.
  useEffect(() => {
    let cancelled = false;
    commitItems([]);
    setPhase("idle");
    setStreaming(false);
    setActivity(null);
    setStreamError(null);
    setCurrentPlan(null);
    if (!activeId) return;

    void (async () => {
      try {
        const [detail, planRes] = await Promise.all([
          api.getSession(activeId),
          api.getSessionPlan(activeId).catch(() => ({ plan: null })),
        ]);
        if (cancelled || activeIdRef.current !== activeId) return;
        const state = new ChatStreamState();
        state.loadHistory(detail.messages);

        if (detail.runState) {
          if (detail.runState.status === "paused") {
            state.phase = "paused";
            state.items.push({
              id: "persisted-paused-note",
              kind: "note",
              tone: "warn",
              text: runStopText(detail.runState),
              action: "continue",
            });
          } else if (detail.runState.status === "interrupted") {
            state.phase = "aborted";
            const reasonText = detail.runState.reason === "server_restart"
              ? "The previous run was interrupted by a server restart; progress was saved. Use Continue to resume."
              : "前次执行已中断，进度已保存。";
            state.items.push({
              id: "persisted-interrupted-note",
              kind: "note",
              tone: "info",
              text: runStopText({ ...detail.runState, message: reasonText }),
              action: "continue",
            });
          } else if (detail.runState.status === "failed") {
            state.phase = "error";
            state.items.push({
              id: "persisted-failed-note",
              kind: "note",
              tone: "error",
              text: "The previous run failed, but progress was saved at the latest checkpoint. Use Continue to resume.",
              action: "continue",
            });
          } else if (detail.runState.status === "completed") {
            state.phase = "done";
          }
        }

        commitItems([...state.items]);
        setPhase(state.phase);
        if (planRes?.plan) {
          setCurrentPlan(planRes.plan);
        }
      } catch (err) {
        if (cancelled || activeIdRef.current !== activeId) return;
        setStreamError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeId, commitItems]);

  const send = useCallback(
    async (prompt: string, files: File[] = []): Promise<void> => {
      const sessionId = activeId;
      if (!sessionId || streaming) return;
      const controller = new AbortController();
      controllers.current.set(sessionId, controller);
      // Seed from the current conversation so multi-turn history survives.
      // Do NOT echo the user message here: the backend's first stream frame is
      // `{ type: "user", content: displayPrompt }` and would duplicate it.
      const state = new ChatStreamState();
      state.items = [...itemsRef.current];
      state.beginTurn();
      setActivity(state.activity);
      setPhase("streaming");
      setStreaming(true);
      setStreamError(null);
      try {
        const response = await api.sendPrompt(sessionId, prompt, files, controller.signal);
        if (!response.ok) {
          let message = `HTTP ${response.status}`;
          try {
            const body = (await response.json()) as { error?: unknown };
            if (body && typeof body.error === "string") message = body.error;
          } catch {
            // Non-JSON error body.
          }
          state.apply({ type: "error", message });
          setPhase("error");
          commitItems([...state.items]);
          return;
        }
        await readNdjson(
          response,
          (raw) => {
            // Session isolation guard (doc §7.3).
            if (activeIdRef.current !== sessionId) return;
            state.apply((raw ?? {}) as WireEvent);
            setActivity(state.activity);
            setPhase(state.phase);
            commitItems([...state.items]);
            if (state.currentPlan) setCurrentPlan(state.currentPlan);
          },
          controller.signal,
        );
        if (activeIdRef.current === sessionId) {
          setPhase(state.phase);
          commitItems([...state.items]);
          if (state.currentPlan) setCurrentPlan(state.currentPlan);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // The server already emitted its own "aborted" event when it stops.
          if (activeIdRef.current === sessionId && state.phase === "streaming") {
            state.apply({ type: "aborted" });
            setPhase("aborted");
            commitItems([...state.items]);
          }
        } else if (activeIdRef.current === sessionId) {
          const message = err instanceof Error ? err.message : String(err);
          state.apply({ type: "error", message });
          setPhase("error");
          setStreamError(message);
          commitItems([...state.items]);
        }
      } finally {
        if (controllers.current.get(sessionId) === controller) {
          controllers.current.delete(sessionId);
        }
        if (activeIdRef.current === sessionId) {
          setStreaming(false);
          setActivity(null);
        }
      }
    },
    [activeId, streaming, commitItems],
  );

  const stop = useCallback((): void => {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    // Aborting the POST request cancels the backend task (server maps the
    // closed request to its internal AbortController - verified in
    // src/server.ts messages route).
    controllers.current.get(sessionId)?.abort();
  }, []);

  const resolvePermissionLocally = useCallback((requestId: string): void => {
    commitItems(
      itemsRef.current.map((item) =>
        item.kind === "permission" && item.requestId === requestId
          ? { ...item, status: "resolved" as const }
          : item,
      ),
    );
  }, [commitItems]);

  const continueSession = useCallback(async (budget: ContinueRunRequest = {}): Promise<void> => {
    const sessionId = activeId;
    if (!sessionId || streaming) return;
    const controller = new AbortController();
    controllers.current.set(sessionId, controller);
    const state = new ChatStreamState();
    // Filter out previous resume notes
    state.items = itemsRef.current.filter((item) => item.kind !== "note" || !item.action);
    state.beginTurn();
    setActivity(state.activity);
    setPhase("streaming");
    setStreaming(true);
    setStreamError(null);
    try {
      const response = await api.continueSession(sessionId, controller.signal, budget);
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const body = (await response.json()) as { error?: unknown };
          if (body && typeof body.error === "string") message = body.error;
        } catch {
          // ignore
        }
        state.apply({ type: "error", message });
        setPhase("error");
        commitItems([...state.items]);
        return;
      }
      await readNdjson(
        response,
        (raw) => {
          if (activeIdRef.current !== sessionId) return;
          state.apply((raw ?? {}) as WireEvent);
          setActivity(state.activity);
          setPhase(state.phase);
          commitItems([...state.items]);
          if (state.currentPlan) setCurrentPlan(state.currentPlan);
        },
        controller.signal,
      );
      if (activeIdRef.current === sessionId) {
        setPhase(state.phase);
        commitItems([...state.items]);
        if (state.currentPlan) setCurrentPlan(state.currentPlan);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        if (activeIdRef.current === sessionId && state.phase === "streaming") {
          state.apply({ type: "aborted" });
          setPhase("aborted");
          commitItems([...state.items]);
        }
      } else if (activeIdRef.current === sessionId) {
        const message = err instanceof Error ? err.message : String(err);
        state.apply({ type: "error", message });
        setPhase("error");
        setStreamError(message);
        commitItems([...state.items]);
      }
    } finally {
      if (controllers.current.get(sessionId) === controller) {
        controllers.current.delete(sessionId);
      }
      if (activeIdRef.current === sessionId) {
        setStreaming(false);
        setActivity(null);
      }
    }
  }, [activeId, streaming, commitItems]);

  return { items, phase, streaming, activity, streamError, send, continueSession, stop, currentPlan, resolvePermissionLocally };
}
