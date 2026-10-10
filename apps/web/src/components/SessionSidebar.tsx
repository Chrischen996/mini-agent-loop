import type { SessionSummary } from "../types/api.ts";

export function SessionSidebar({
  sessions,
  activeId,
  busy,
  loading,
  error,
  onNew,
  onSelect,
  onDelete,
}: {
  sessions: SessionSummary[];
  activeId: string | null;
  busy: boolean;
  loading: boolean;
  error: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <aside className="panel panel--sessions">
      <div className="panel__head">
        <h2>Sessions</h2>
        <button type="button" className="btn btn--primary" onClick={onNew} disabled={busy}>
          New
        </button>
      </div>

      {loading && sessions.length === 0 && <p className="muted">Loading…</p>}
      {error && <p className="muted error">{error}</p>}
      {!loading && !error && sessions.length === 0 && (
        <p className="muted">No sessions yet. Create one to start.</p>
      )}

      <ul className="list">
        {sessions.map((session) => (
          <li key={session.id} className={session.id === activeId ? "row row--active" : "row"}>
            <button type="button" className="row__main" onClick={() => onSelect(session.id)}>
              <span className="row__title">{session.modelId ?? "default model"}</span>
              <span className="row__meta">
                {new Date(session.lastActiveAt).toLocaleString()} · {session.messageCount} msgs
              </span>
            </button>
            <button
              type="button"
              className="row__delete"
              title="Delete session"
              onClick={() => onDelete(session.id)}
              disabled={session.busy || session.id === activeId && busy}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
