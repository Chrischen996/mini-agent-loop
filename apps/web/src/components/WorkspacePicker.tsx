import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { Icon } from "./Icon.tsx";

type Directory = { name: string; path: string };

export function WorkspacePicker({ open, onClose, onPick }: {
  open: boolean;
  onClose: () => void;
  onPick: (path: string) => Promise<void>;
}) {
  const [currentPath, setCurrentPath] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const [directories, setDirectories] = useState<Directory[]>([]);
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLElement | null>(null);

  const browse = async (path?: string) => {
    setLoading(true);
    setError(null);
    if (path !== undefined) setCurrentPath("");
    try {
      const result = await api.browseWorkspaceDirectories(path);
      setCurrentPath(result.path);
      setPathDraft(result.path);
      setParent(result.parent);
      setDirectories(result.directories);
    } catch (err) {
      setCurrentPath("");
      setError(err instanceof Error ? err.message : String(err));
    } finally { setLoading(false); }
  };

  useEffect(() => {
    if (!open) return;
    void browse();
    dialog.current?.focus();
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); previous?.focus(); };
  }, [open]);

  if (!open) return null;
  const choose = async () => {
    if (!currentPath || saving) return;
    setSaving(true);
    setError(null);
    try { await onPick(currentPath); onClose(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  };

  return <div className="settings-overlay workspace-picker-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} className="directory-dialog" role="dialog" aria-modal="true" aria-labelledby="directory-title" tabIndex={-1}>
      <header className="directory-dialog__header"><div><h2 id="directory-title">Select Workspace Directory</h2></div><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><Icon name="close" /></button></header>
      <div className="directory-location">
        {editingPath ? <form onSubmit={(event) => { event.preventDefault(); setEditingPath(false); void browse(pathDraft); }}><input autoFocus aria-label="Workspace directory path" value={pathDraft} onChange={(event) => setPathDraft(event.target.value)} /><button type="submit" className="icon-button" aria-label="Open path"><Icon name="check" /></button></form> : <><span title={currentPath}>{currentPath || "Loading directory…"}</span><button type="button" className="icon-button" aria-label="Edit path" title="Edit path" onClick={() => setEditingPath(true)}><Icon name="more" /></button></>}
      </div>
      <div className="directory-list" role="listbox" aria-label="Directories">
        {parent && <button type="button" role="option" className="directory-row" onClick={() => void browse(parent)}><Icon name="folder" /><span>..</span></button>}
        {directories.map((directory) => <button type="button" role="option" key={directory.path} className="directory-row" onClick={() => void browse(directory.path)}><Icon name="folder" /><span>{directory.name}</span><Icon name="chevronLeft" className="directory-row__next" /></button>)}
        {!loading && directories.length === 0 && !error && <p className="directory-empty">No subfolders</p>}
        {loading && <p className="directory-empty">Loading…</p>}
      </div>
      {error && <p className="error directory-error" role="alert">{error}</p>}
      <footer className="directory-dialog__footer"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn--primary" onClick={() => void choose()} disabled={!currentPath || editingPath || loading || saving}>{saving ? "Adding…" : "Open"}</button></footer>
    </section>
  </div>;
}
