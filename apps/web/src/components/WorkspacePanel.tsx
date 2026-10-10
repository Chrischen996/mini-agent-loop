import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { WorkspaceEntry } from "../types/api.ts";

export function WorkspacePanel({ rootPath = "" }: { rootPath?: string }) {
  const [entries, setEntries] = useState<WorkspaceEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState(rootPath);
  const [truncated, setTruncated] = useState(false);

  const loadDir = async (path: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listWorkspace(path);
      setEntries(data.entries);
      setTruncated(data.truncated);
      setCurrentPath(data.path ?? path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDir(rootPath);
  }, [rootPath]);

  const navigateUp = (): void => {
    if (!currentPath) return;
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    const parent = parts.join("/");
    void loadDir(parent);
  };

  const navigateTo = (entry: WorkspaceEntry): void => {
    if (entry.type === "dir") {
      void loadDir(entry.path);
    }
  };

  return (
    <aside className="panel panel--workspace">
      <div className="panel__head">
        <h2>Workspace</h2>
        <span className="muted" title={currentPath || "root"}>
          {currentPath ? `/${currentPath}` : "/"}
        </span>
      </div>

      {currentPath ? (
        <div style={{ marginBottom: 6 }}>
          <button
            type="button"
            className="btn"
            style={{ fontSize: 11, padding: "2px 8px" }}
            onClick={navigateUp}
            disabled={loading}
          >
            .. (Up)
          </button>
        </div>
      ) : null}

      {loading && !entries ? (
        <p className="muted">Loading…</p>
      ) : error ? (
        <p className="muted error">{error}</p>
      ) : !entries || entries.length === 0 ? (
        <p className="muted">Empty directory.</p>
      ) : (
        <ul className="list">
          {entries.map((entry) => (
            <li key={entry.path} className={`row row--file row--${entry.type}`}>
              <button
                type="button"
                className="row__main"
                onClick={() => navigateTo(entry)}
                title={entry.path}
              >
                <span className="row__icon">{entry.type === "dir" ? "📁" : "📄"}</span>
                <span className="row__title">{entry.name}</span>
                {entry.type === "dir" ? <span className="row__meta">/</span> : null}
              </button>
            </li>
          ))}
          {truncated ? (
            <li className="muted" style={{ fontSize: 11, padding: "4px 8px" }}>
              …truncated ({entries.length} shown)
            </li>
          ) : null}
        </ul>
      )}
    </aside>
  );
}
