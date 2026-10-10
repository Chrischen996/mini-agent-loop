import { useCallback, useEffect, useMemo, useState } from "react";
import { ChatComposer } from "./components/ChatComposer";
import { ChatView } from "./components/ChatView";
import { ModelSelector } from "./components/ModelSelector";
import { PlanPanel } from "./components/PlanPanel";
import { SessionSidebar } from "./components/SessionSidebar";
import { StatusBar } from "./components/StatusBar";
import { ToolActivityPanel } from "./components/ToolActivityPanel";
import { WorkspacePanel } from "./components/WorkspacePanel";
import { useAgentStream } from "./hooks/useAgentStream";
import { useSessions } from "./hooks/useSessions";
import { api } from "./lib/api";

type ApiHealth = "checking" | "connected" | "disconnected";

function useApiHealth(): ApiHealth {
  const [status, setStatus] = useState<ApiHealth>("checking");
  useEffect(() => {
    let cancelled = false;
    const check = async (): Promise<void> => {
      try {
        const response = await fetch("/api/health");
        if (!cancelled) setStatus(response.ok ? "connected" : "disconnected");
      } catch {
        if (!cancelled) setStatus("disconnected");
      }
    };
    void check();
    const timer = setInterval(() => void check(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return status;
}

/**
 * P4 workbench: session management, streaming chat, tool activity, plan panel,
 * workspace tree, model selector and permission approval.
 */
export function App() {
  const connected = useApiHealth();
  const {
    sessions,
    activeId,
    setActiveId,
    refresh,
    createSession,
    creating,
    loading,
    error: listError,
  } = useSessions();
  const { items, phase, streaming, streamError, send, stop, currentPlan, resolvePermissionLocally } =
    useAgentStream(activeId);

  const active = useMemo(
    () => sessions.find((session) => session.id === activeId) ?? null,
    [sessions, activeId],
  );

  // Refresh the session list when a stream ends so messageCount / lastActiveAt
  // in the sidebar stay current.
  useEffect(() => {
    if (phase === "done" || phase === "error" || phase === "aborted") {
      void refresh();
    }
  }, [phase, refresh]);

  const deleteSession = useCallback(
    async (id: string): Promise<void> => {
      try {
        await api.deleteSession(id);
        if (activeId === id) setActiveId(null);
        await refresh();
      } catch (err) {
        console.error("delete session failed", err);
      }
    },
    [activeId, setActiveId, refresh],
  );

  const handlePermissionResolve = useCallback(
    async (requestId: string): Promise<void> => {
      resolvePermissionLocally(requestId);
      if (activeId) {
        await refresh();
      }
    },
    [activeId, refresh, resolvePermissionLocally],
  );

  return (
    <div className="workbench">
      <header className="workbench__header">
        <h1>Mini Agent Workbench</h1>
        <ModelSelector
          sessionId={activeId}
          currentModel={active?.modelId ?? null}
          disabled={streaming}
          onModelChange={() => void refresh()}
        />
      </header>

      <main className="workbench__main">
        <SessionSidebar
          sessions={sessions}
          activeId={activeId}
          busy={streaming}
          loading={loading}
          error={listError}
          onNew={() => void createSession()}
          onSelect={setActiveId}
          onDelete={(id) => void deleteSession(id)}
        />

        <div className="workbench__center">
          <ChatView
            items={items}
            phase={phase}
            sessionTitle={active ? active.id.slice(0, 8) : null}
            sessionId={activeId}
            onPermissionResolve={handlePermissionResolve}
          />
          {streamError ? <p className="muted error">{streamError}</p> : null}
          <ChatComposer
            disabled={!activeId || connected === "disconnected"}
            streaming={streaming}
            onSend={(prompt) => void send(prompt)}
            onStop={stop}
          />
        </div>

        <div className="workbench__right">
          <WorkspacePanel rootPath="" />
          <ToolActivityPanel items={items} />
          <PlanPanel plan={currentPlan} />
        </div>
      </main>

      <StatusBar
        connected={connected}
        sessionTitle={active ? active.id.slice(0, 8) : null}
        model={active?.modelId ?? null}
        streaming={streaming}
        phase={phase}
      />
    </div>
  );
}

export type { ApiHealth };
