import { useEffect, useMemo, useRef, useState } from "react";
import type { ForeignSessionCandidate, SessionSummary, WorkspaceRecord } from "../types/api.ts";
import { api } from "../lib/api.ts";
import { Icon } from "./Icon.tsx";
import { FishLogo } from "./FishLogo.tsx";

export function SessionSidebar({ sessions, activeId, busy, streaming, loading, error, collapsed, connected, workspaces, workspaceId, onWorkspaceChange, onAddWorkspace, onToggle, onNew, onImport, importMatches = [], onSelect, onDelete, onPresentation, onSettings }: {
  sessions: SessionSummary[];
  activeId: string | null;
  busy: boolean;
  streaming: boolean;
  loading: boolean;
  error: string | null;
  collapsed: boolean;
  connected: string;
  workspaces: WorkspaceRecord[];
  workspaceId: string;
  onWorkspaceChange: (id: string) => void;
  onAddWorkspace: () => void;
  onToggle: () => void;
  onNew: (workspaceId?: string) => void;
  onImport: (source: "claude" | "codex", reference: string) => void;
  importMatches?: ForeignSessionCandidate[];
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onPresentation: (id: string, patch: { title?: string; pinned?: boolean; archived?: boolean }) => Promise<void>;
  onSettings: () => void;
}) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(workspaceId ? [workspaceId] : []));
  const [sessionLimits, setSessionLimits] = useState<Record<string, number>>({});
  const [showArchived, setShowArchived] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [openSessionMenu, setOpenSessionMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [presentationError, setPresentationError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importSource, setImportSource] = useState<"claude" | "codex">("claude");
  const [importSessions, setImportSessions] = useState<ForeignSessionCandidate[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const viewMenu = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (workspaceId) setExpanded((current) => new Set(current).add(workspaceId));
  }, [workspaceId]);
  useEffect(() => {
    if (!collapsed && searchOpen) searchInput.current?.focus();
  }, [collapsed, searchOpen]);
  useEffect(() => {
    if (!viewMenuOpen) return;
    const closeOutside = (event: PointerEvent) => { if (!viewMenu.current?.contains(event.target as Node)) setViewMenuOpen(false); };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setViewMenuOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("keydown", closeEscape); };
  }, [viewMenuOpen]);
  useEffect(() => {
    if (!importOpen) return;
    let cancelled = false;
    setImportLoading(true);
    setImportError(null);
    void api.listForeignSessions(importSource, workspaceId || undefined).then((listed) => {
      if (cancelled) return;
      setImportSessions(listed.sessions);
      if (!listed.configDirExists) setImportError(`Checked ${listed.configDir}; that directory is not available.`);
    }).catch((err) => {
      if (!cancelled) setImportError(err instanceof Error ? err.message : String(err));
    }).finally(() => { if (!cancelled) setImportLoading(false); });
    return () => { cancelled = true; };
  }, [importOpen, importSource, workspaceId]);
  const normalizedQuery = query.trim().toLowerCase();
  const orderedSessions = useMemo(() => [...sessions].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.lastActiveAt - a.lastActiveAt), [sessions]);
  const matches = (session: SessionSummary) => `${session.id} ${session.preview ?? ""} ${session.modelId ?? ""}`.toLowerCase().includes(normalizedQuery);
  const timeAgo = (timestamp: number): string => {
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return days < 30 ? `${days}d ago` : new Date(timestamp).toLocaleDateString();
  };
  return (
    <aside className={`panel panel--sessions${collapsed ? " panel--sessions-collapsed" : ""}`} aria-label="Sessions">
      <div className="sidebar__brand">
        {!collapsed && <><FishLogo size={24} className="sidebar__fish" /><span className="sidebar__name">Mini Agent</span></>}
        <button type="button" className="icon-button sidebar__toggle" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} onClick={onToggle}><Icon name="sidebar" /></button>
      </div>
      <button type="button" className="btn btn--new" onClick={() => onNew(workspaceId || undefined)} disabled={busy} aria-label="New session" title="New session"><Icon name="new" />{!collapsed && <span>New session</span>}</button>
      {!collapsed && <button type="button" className="sidebar__import" onClick={() => setImportOpen((open) => !open)} aria-expanded={importOpen}>Import Claude or Codex</button>}
      {!collapsed && importOpen && <div className="sidebar__import-panel">
        <div className="sidebar__import-sources">
          <button type="button" aria-pressed={importSource === "claude"} onClick={() => setImportSource("claude")}>Claude</button>
          <button type="button" aria-pressed={importSource === "codex"} onClick={() => setImportSource("codex")}>Codex</button>
        </div>
        {importLoading && <p className="muted">Loading…</p>}
        {importError && <p className="error" role="alert">{importError}</p>}
        {importMatches.length > 0 && <ul className="sidebar__import-list">
          {importMatches.map((session) => <li key={`match-${session.session_id}`}>
            <button type="button" disabled={busy} onClick={() => onImport(importSource, session.session_id)}>
              {session.title || session.session_id.slice(0, 8)}
            </button>
          </li>)}
        </ul>}
        {!importLoading && importSessions.length === 0 && !importError && <p className="muted">No sessions for this workspace.</p>}
        <ul className="sidebar__import-list">
          {importSessions.slice(0, 8).map((session) => <li key={session.session_id}>
            <button type="button" disabled={busy} onClick={() => { onImport(importSource, session.session_id); setImportOpen(false); }}>
              {session.title || session.session_id.slice(0, 8)}
            </button>
          </li>)}
        </ul>
      </div>}
      {!collapsed && <div className={`sidebar__section-heading${searchOpen ? " sidebar__section-heading--search" : ""}`}>
        {!searchOpen ? <><span>Workspaces</span><button type="button" className="icon-button" aria-label="Search sessions" title="Search sessions" onClick={() => { setSearchOpen(true); requestAnimationFrame(() => searchInput.current?.focus()); }}><Icon name="search" /></button><div className="sidebar__view-menu" ref={viewMenu}><button type="button" className="icon-button" aria-label="View options" title="View options" aria-expanded={viewMenuOpen} onClick={() => setViewMenuOpen((open) => !open)}><Icon name="more" /></button>{viewMenuOpen && <div className="session-menu view-menu" role="menu"><div className="view-menu__label">Sessions</div><button type="button" role="menuitemcheckbox" aria-checked={showArchived} onClick={() => { setShowArchived((value) => !value); setViewMenuOpen(false); }}><span className="view-menu__check">{showArchived ? "✓" : ""}</span>Show archived</button></div>}</div><button type="button" className="icon-button" aria-label="Add workspace" title="Add workspace" onClick={onAddWorkspace}><Icon name="plus" /></button></> : <>
          <Icon name="search" /><input ref={searchInput} type="search" aria-label="Search sessions" placeholder="Search sessions" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setQuery(""); setSearchOpen(false); } }} /><button type="button" className="icon-button" aria-label="Close search" title="Close search" onClick={() => { setQuery(""); setSearchOpen(false); }}><Icon name="close" /></button>
        </>}
      </div>}
      {presentationError && <p className="error sidebar__action-error" role="alert">{presentationError}</p>}
      {collapsed ? <div className="sidebar__rail-actions"><button type="button" className="icon-button" onClick={() => { setSearchOpen(true); onToggle(); }} aria-label="Search sessions" title="Search sessions"><Icon name="search" /></button><button type="button" className="icon-button" onClick={onAddWorkspace} aria-label="Add workspace" title="Add workspace"><Icon name="plus" /></button></div> : <>
        {loading && sessions.length === 0 && <p className="muted">Loading…</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="workspace-tree" role="tree" aria-label="Workspaces and sessions">
          {workspaces.map((workspace) => {
            const workspaceSessions = orderedSessions.filter((session) => session.workspaceId === workspace.id && (showArchived || !session.archived) && (!normalizedQuery || matches(session) || workspace.name.toLowerCase().includes(normalizedQuery)));
            const isExpanded = expanded.has(workspace.id) || Boolean(normalizedQuery && workspaceSessions.length);
            const limit = normalizedQuery ? workspaceSessions.length : sessionLimits[workspace.id] ?? 5;
            const shownSessions = workspaceSessions.slice(0, limit);
            const activeSession = workspaceSessions.find((session) => session.id === activeId);
            if (activeSession && !shownSessions.some((session) => session.id === activeSession.id)) shownSessions.push(activeSession);
            return <section className={`workspace-group${workspace.id === workspaceId ? " workspace-group--active" : ""}`} key={workspace.id} role="treeitem" aria-expanded={isExpanded}>
              <div className="workspace-group__header">
                <button type="button" className="workspace-group__select" onClick={() => { onWorkspaceChange(workspace.id); setExpanded((current) => { const next = new Set(current); if (next.has(workspace.id)) next.delete(workspace.id); else next.add(workspace.id); return next; }); }} aria-label={`Toggle workspace ${workspace.name}`} aria-expanded={isExpanded} title={workspace.path}>
                  <span className={`workspace-group__chevron${isExpanded ? " workspace-group__chevron--open" : ""}`} aria-hidden="true">›</span><Icon name="folder" /><span className="workspace-group__name">{workspace.name}</span>
                </button>
                <button type="button" className="icon-button workspace-group__new" aria-label={`New session in ${workspace.name}`} title={`New session in ${workspace.name}`} onClick={() => { onWorkspaceChange(workspace.id); onNew(workspace.id); }}><Icon name="plus" width={15} height={15} /></button>
              </div>
              {isExpanded && <>
                <ul className="list workspace-group__sessions" role="group">
                {shownSessions.map((session) => <li key={session.id} className={`${session.id === activeId ? "row row--active" : "row"}${session.archived ? " row--archived" : ""}`} role="treeitem" aria-selected={session.id === activeId}>
                  <button type="button" className="row__main" onClick={() => onSelect(session.id)} aria-current={session.id === activeId ? "page" : undefined}>
                    <span className="row__title" title={session.title || session.preview || (session.messageCount === 0 ? "New session" : `Session ${session.id.slice(0, 8)}`)}>{session.pinned ? <span className="row__pin" aria-label="Pinned">◆ </span> : null}{session.title || session.preview || (session.messageCount === 0 ? "New session" : `Session ${session.id.slice(0, 8)}`)}{session.busy ? <span className="session-running" title="Running"> ·</span> : null}</span>
                    <span className="row__meta">{timeAgo(session.lastActiveAt)}</span>
                  </button>
                  {renaming === session.id ? <form className="row__rename" onSubmit={(event) => { event.preventDefault(); void onPresentation(session.id, { title: titleDraft }).then(() => setRenaming(null)).catch((err) => setPresentationError(err instanceof Error ? err.message : String(err))); }}><input autoFocus aria-label="Session name" maxLength={200} value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setRenaming(null); }} /><button type="submit" className="icon-button" aria-label="Save session name"><Icon name="check" width={14} height={14} /></button></form> : <div className="row__menu-wrap"><button type="button" className="row__delete row__more" title="Session options" aria-label={`Session options ${session.title || session.id.slice(0, 8)}`} aria-expanded={openSessionMenu === session.id} onClick={() => setOpenSessionMenu((current) => current === session.id ? null : session.id)}><Icon name="more" width={16} height={16} /></button>{openSessionMenu === session.id && <div className="session-menu" role="menu">
                    <button type="button" role="menuitem" onClick={() => { setTitleDraft(session.title || session.preview || ""); setRenaming(session.id); setOpenSessionMenu(null); }}>Rename</button>
                    <button type="button" role="menuitem" onClick={() => { void onPresentation(session.id, { pinned: !session.pinned }).catch((err) => setPresentationError(err instanceof Error ? err.message : String(err))); setOpenSessionMenu(null); }}>{session.pinned ? "Unpin" : "Pin"}</button>
                    <button type="button" role="menuitem" onClick={() => { void onPresentation(session.id, { archived: !session.archived }).catch((err) => setPresentationError(err instanceof Error ? err.message : String(err))); setOpenSessionMenu(null); }}>{session.archived ? "Restore from archive" : "Archive"}</button>
                    <button type="button" role="menuitem" className="session-menu__danger" onClick={() => { setOpenSessionMenu(null); onDelete(session.id); }} disabled={session.busy || session.id === activeId && streaming}>Delete</button>
                  </div>}</div>}
                </li>)}
                </ul>
                {!normalizedQuery && workspaceSessions.length > 5 && <button type="button" className="workspace-group__more" onClick={() => setSessionLimits((current) => ({ ...current, [workspace.id]: (current[workspace.id] ?? 5) >= workspaceSessions.length ? 5 : Math.min(workspaceSessions.length, (current[workspace.id] ?? 5) + 5) }))}>
                  {(sessionLimits[workspace.id] ?? 5) >= workspaceSessions.length ? "Show less" : `Show ${Math.min(5, workspaceSessions.length - (sessionLimits[workspace.id] ?? 5))} more`}
                </button>}
              </>}
            </section>;
          })}
          {!loading && !error && workspaces.length === 0 && <p className="sidebar__empty">Add a workspace to get started.</p>}
          {!loading && !error && normalizedQuery && workspaces.every((workspace) => !sessions.some((session) => session.workspaceId === workspace.id && (matches(session) || workspace.name.toLowerCase().includes(normalizedQuery)))) && <p className="sidebar__empty">No matching workspaces or sessions.</p>}
        </div>
      </>}
      <div className="sidebar__footer">
        <button type="button" className="sidebar__settings" onClick={onSettings}><Icon name="settings" /><span>Settings</span></button>
        <span className={`connection-dot connection-dot--${connected}`} title={`API ${connected}`} aria-label={`API ${connected}`} />
      </div>
    </aside>
  );
}
