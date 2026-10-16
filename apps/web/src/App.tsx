import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ChatComposer } from "./components/ChatComposer";
import { ChatView } from "./components/ChatView";
import { ModelSelector } from "./components/ModelSelector";
import { PlanPanel } from "./components/PlanPanel";
import { SessionSidebar } from "./components/SessionSidebar";
import { ToolActivityPanel } from "./components/ToolActivityPanel";
import { WorkspacePanel } from "./components/WorkspacePanel";
import { useAgentStream } from "./hooks/useAgentStream";
import { useSessions } from "./hooks/useSessions";
import { api } from "./lib/api";
import { Icon } from "./components/Icon.tsx";
import { workbenchColumns } from "./lib/layout.ts";
import { workspacePanelScope } from "./lib/workspace-scope.ts";
import type { WorkspaceRecord } from "./types/api.ts";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { FishLogo } from "./components/FishLogo.tsx";
import { WorkspacePicker } from "./components/WorkspacePicker.tsx";

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
  const [viewport, setViewport] = useState(window.innerWidth);
  const [sidebarChoice, setSidebarChoice] = useState<boolean | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [dockWidth, setDockWidth] = useState<number | null>(null);
  const [dock, setDock] = useState<"files" | "activity" | "plan" | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelPickerSearch, setModelPickerSearch] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem("mini-agent-theme") ?? "system");
  const workspaceChip = useRef<HTMLDivElement | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const collapsed = sidebarChoice ?? viewport < 1024;
  const columns = workbenchColumns(viewport, (collapsed || viewport <= 720) ? 0 : sidebarWidth, dock ? dockWidth ?? viewport * 0.45 : 0);
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setDock(null); setFullscreen(false); }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  useEffect(() => {
    if (!workspaceMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!workspaceChip.current?.contains(event.target as Node)) setWorkspaceMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setWorkspaceMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [workspaceMenuOpen]);
  const resizePanel = (event: ReactPointerEvent<HTMLDivElement>, side: "left" | "right") => {
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.startX = String(event.clientX);
    event.currentTarget.dataset.startWidth = String(side === "left" ? sidebarWidth : dockWidth ?? viewport * 0.45);
  };
  const dragPanel = (event: ReactPointerEvent<HTMLDivElement>, side: "left" | "right") => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const delta = event.clientX - Number(event.currentTarget.dataset.startX);
    const start = Number(event.currentTarget.dataset.startWidth);
    if (side === "left") setSidebarWidth(Math.min(420, Math.max(264, start + delta)));
    else setDockWidth(Math.min(viewport * 0.7, Math.max(300, start - delta)));
  };
  const openDock = (panel: "files" | "activity" | "plan") => { setDock(panel); setFullscreen(false); };
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
  useEffect(() => {
    let cancelled = false;
    void api.listWorkspaces().then((items) => {
      if (cancelled) return;
      setWorkspaces(items);
      setSelectedWorkspaceId((current) => current || items[0]?.id || "");
    }).catch((err) => setActionError(err instanceof Error ? err.message : String(err)));
    return () => { cancelled = true; };
  }, []);
  const { items, phase, streaming, activity, streamError, send, continueSession, stop, currentPlan, resolvePermissionLocally } =
    useAgentStream(activeId);

  const active = useMemo(
    () => sessions.find((session) => session.id === activeId) ?? null,
    [sessions, activeId],
  );
  useEffect(() => {
    document.body.dataset.theme = theme === "system" ? "" : theme;
    document.body.toggleAttribute("data-ds-dark-theme", theme === "dark" || theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    localStorage.setItem("mini-agent-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (active?.workspaceId) setSelectedWorkspaceId(active.workspaceId);
  }, [active?.workspaceId]);

  const handleWorkspaceChange = (id: string) => {
    setSelectedWorkspaceId(id);
  };

  const handleHeroWorkspacePick = async (id: string): Promise<void> => {
    setWorkspaceMenuOpen(false);
    setSelectedWorkspaceId(id);
    if (active?.workspaceId !== id) await createSession(id);
  };

  const handleAddWorkspace = async (root: string): Promise<void> => {
    const result = await api.addWorkspace(root);
    setWorkspaces(await api.listWorkspaces());
    setSelectedWorkspaceId(result.workspace.id);
    const sessionId = await createSession(result.workspace.id);
    if (!sessionId) throw new Error("Could not create a session for this workspace");
  };

  // Refresh the session list when a stream ends so messageCount / lastActiveAt
  // in the sidebar stay current.
  useEffect(() => {
    if (phase === "done" || phase === "error" || phase === "aborted" || phase === "stopped" || phase === "paused") {
      void refresh();
    }
  }, [phase, refresh]);

  const deleteSession = useCallback(
    async (id: string): Promise<void> => {
      try {
        setActionError(null);
        await api.deleteSession(id);
        if (activeId === id) setActiveId(null);
        await refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    },
    [activeId, setActiveId, refresh],
  );
  const updatePresentation = useCallback(async (id: string, patch: { title?: string; pinned?: boolean; archived?: boolean }): Promise<void> => {
    await api.updateSessionPresentation(id, patch);
    await refresh();
  }, [refresh]);

  const handlePermissionResolve = useCallback(
    async (requestId: string): Promise<void> => {
      resolvePermissionLocally(requestId);
      if (activeId) {
        await refresh();
      }
    },
    [activeId, refresh, resolvePermissionLocally],
  );

  const blank = items.length === 0 && !streaming;
  const filesScope = workspacePanelScope(activeId, active?.workspaceId, selectedWorkspaceId);
  const frameStyle = { "--sidebar-width": `${columns.left}px`, "--dock-width": `${columns.right}px`, "--dock-panel-width": `${columns.right || Math.min(viewport - columns.left, Math.max(300, dockWidth ?? viewport * 0.45))}px` } as CSSProperties;
  return (
    <div className={`workbench${collapsed ? " workbench--collapsed" : ""}${columns.overlay ? " workbench--overlay" : ""}`} style={frameStyle}>
      <SessionSidebar
        sessions={sessions} activeId={activeId} busy={creating} streaming={streaming} loading={loading} error={listError}
        collapsed={collapsed} connected={connected}
        workspaces={workspaces} workspaceId={selectedWorkspaceId} onWorkspaceChange={handleWorkspaceChange} onAddWorkspace={() => setWorkspacePickerOpen(true)}
        onToggle={() => setSidebarChoice(!collapsed)}
        onNew={(workspaceId) => void createSession(workspaceId ?? (selectedWorkspaceId || undefined))} onSelect={(id) => { setActiveId(id); const selected = sessions.find((session) => session.id === id); if (selected?.workspaceId) setSelectedWorkspaceId(selected.workspaceId); }}
        onDelete={(id) => void deleteSession(id)}
        onPresentation={updatePresentation}
        onSettings={() => setSettingsOpen(true)}
      />
      {!collapsed && <div className="resize-handle resize-handle--left" role="separator" aria-label="Resize sessions" aria-orientation="vertical" aria-valuenow={sidebarWidth} aria-valuemin={264} aria-valuemax={420} tabIndex={0}
        onPointerDown={(event) => resizePanel(event, "left")} onPointerMove={(event) => dragPanel(event, "left")}
        onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setSidebarWidth(Math.min(420, Math.max(264, sidebarWidth + (event.key === "ArrowRight" ? 16 : -16)))); } }} />}
      <main className={`workbench__center${blank ? " workbench__center--blank" : ""}`}>
        <header className="workbench__header">
          <div className="workbench__title">{!blank && <h1>{active?.title || active?.preview || (active?.messageCount === 0 ? "New session" : `Session ${activeId?.slice(0, 8)}`)}</h1>}</div>
          <nav className="header-actions" aria-label="Workspace panels">
            <button type="button" className={`icon-button${dock ? " icon-button--active" : ""}`} aria-label={dock ? "Close workspace panel" : "Open workspace panel"} title={dock ? "Close workspace panel" : "Open workspace panel"} aria-pressed={Boolean(dock)} onClick={() => dock ? setDock(null) : openDock("files")}><Icon name="sidebar" /></button>
          </nav>
        </header>
        <div className="conversation-body">
          {blank && <div className="empty-hero"><FishLogo size={34} className="hero-mark" /><div className="empty-hero__title"><h2>How can I help?</h2></div></div>}
          <ChatView items={items} phase={phase} activity={streaming ? activity : null} onStop={stop} sessionTitle={active ? active.title || active.preview || active.id.slice(0, 8) : null} sessionId={activeId} onPermissionResolve={handlePermissionResolve} onContinue={() => void continueSession()} />
          {streamError || actionError ? <p role="alert" className="stream-error error">{streamError ?? actionError}</p> : null}
          <div className="composer-seat">
            {blank && <div className="hero-workspace-select" ref={workspaceChip}>
              <button type="button" className="workspace-chip" aria-haspopup="menu" aria-expanded={workspaceMenuOpen} onClick={() => setWorkspaceMenuOpen((open) => !open)}>
                <Icon name="folder" /> {workspaces.find((item) => item.id === active?.workspaceId)?.name ?? "Choose workspace"} <span aria-hidden="true">⌄</span>
              </button>
              {workspaceMenuOpen && <div className="hero-workspace-menu" role="menu" aria-label="Choose workspace">
                {workspaces.map((workspace) => <button key={workspace.id} type="button" role="menuitemradio" aria-checked={workspace.id === active?.workspaceId} className="hero-workspace-menu__item" onClick={() => void handleHeroWorkspacePick(workspace.id)}>
                  <Icon name="folder" width={16} height={16} /><span>{workspace.name}</span>{workspace.id === active?.workspaceId && <span aria-hidden="true">✓</span>}
                </button>)}
              </div>}
            </div>}
            <ChatComposer key={activeId ?? "draft"} disabled={creating || !activeId || connected === "disconnected"} streaming={streaming} onSend={(prompt, files) => void send(prompt, files)} onStop={stop}
              onModelCommand={() => { setModelPickerSearch(true); setModelPickerOpen(true); }}
              controls={<ModelSelector sessionId={activeId} currentModel={active?.modelId ?? null} currentThinkingLevel={active?.thinkingLevel ?? null} disabled={streaming} open={modelPickerOpen} forceSearch={modelPickerSearch} onOpenChange={(open) => { setModelPickerOpen(open); if (!open) setModelPickerSearch(false); }} onModelChange={() => void refresh()} />} />
          </div>
        </div>
      </main>
      <aside className={`workbench__right${fullscreen ? " workbench__right--fullscreen" : ""}`} hidden={!dock} aria-label="Workspace panel">
        {dock && <>
          {!fullscreen && !columns.overlay && <div className="resize-handle resize-handle--right" role="separator" aria-label="Resize workspace" aria-orientation="vertical" aria-valuenow={columns.right} aria-valuemin={300} aria-valuemax={viewport * 0.7} tabIndex={0}
            onPointerDown={(event) => resizePanel(event, "right")} onPointerMove={(event) => dragPanel(event, "right")}
            onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setDockWidth(Math.min(viewport * 0.7, Math.max(300, (dockWidth ?? viewport * 0.45) + (event.key === "ArrowLeft" ? 16 : -16)))); } }} />}
          <div className="workspace-tabs" role="tablist" aria-label="Workspace views">
            {(["files", "activity", "plan"] as const).map((panel) => <button type="button" key={panel} role="tab" id={`dock-tab-${panel}`} aria-controls={`dock-panel-${panel}`} aria-selected={dock === panel} tabIndex={dock === panel ? 0 : -1} className={`dock__tab${dock === panel ? " dock__tab--on" : ""}`} onClick={() => setDock(panel)} onKeyDown={(event) => {
              const panels = ["files", "activity", "plan"] as const;
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); const next = panels[(panels.indexOf(panel) + (event.key === "ArrowRight" ? 1 : 2)) % 3]; setDock(next); document.getElementById(`dock-tab-${next}`)?.focus(); }
            }}>{panel === "files" ? "Files" : panel === "activity" ? "Activity" : "Plan"}</button>)}
            <div className="workspace-tabs__actions"><button type="button" className="icon-button" aria-label={fullscreen ? "Exit fullscreen" : "Expand panel"} aria-pressed={fullscreen} onClick={() => setFullscreen(!fullscreen)}><Icon name="expand" /></button><button type="button" className="icon-button" aria-label="Close panel" onClick={() => { setDock(null); setFullscreen(false); }}><Icon name="close" /></button></div>
          </div>
          <div id="dock-panel-files" role="tabpanel" aria-labelledby="dock-tab-files" className="workspace-pane" hidden={dock !== "files"}><WorkspacePanel key={`${activeId ?? "none"}:${selectedWorkspaceId}`} rootPath="" {...filesScope} embedded /></div>
          <div id="dock-panel-activity" role="tabpanel" aria-labelledby="dock-tab-activity" className="workspace-pane workspace-pane--scroll" hidden={dock !== "activity"}><ToolActivityPanel items={items} /></div>
          <div id="dock-panel-plan" role="tabpanel" aria-labelledby="dock-tab-plan" className="workspace-pane workspace-pane--scroll" hidden={dock !== "plan"}><PlanPanel plan={currentPlan} /></div>
        </>}
      </aside>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} theme={theme} onThemeChange={setTheme} sessionId={activeId} permissionMode={active?.permissionMode ?? "plan"} model={active?.modelId ?? null} thinkingLevel={active?.thinkingLevel ?? null} onModelChange={() => void refresh()} onPermissionChange={async (mode) => { if (!activeId) return; await api.setPermissionMode(activeId, mode); await refresh(); }} />
      <WorkspacePicker open={workspacePickerOpen} onClose={() => setWorkspacePickerOpen(false)} onPick={handleAddWorkspace} />
    </div>
  );
}

export type { ApiHealth };
