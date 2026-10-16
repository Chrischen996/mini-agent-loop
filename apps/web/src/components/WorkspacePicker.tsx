import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { Icon } from "./Icon.tsx";

type Directory = { name: string; path: string; hidden?: boolean };
type Crumb = { name: string; path: string };
type Listing = {
  path: string;
  parent: string | null;
  home: string;
  crumbs: Crumb[];
  directories: Directory[];
  truncated?: boolean;
};

export function WorkspacePicker({ open, onClose, onPick }: {
  open: boolean;
  onClose: () => void;
  onPick: (path: string) => Promise<void>;
}) {
  const [currentPath, setCurrentPath] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const [home, setHome] = useState("");
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [parents, setParents] = useState<Directory[]>([]);
  const [children, setChildren] = useState<Directory[]>([]);
  const [selected, setSelected] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLElement | null>(null);

  const visible = (entries: Directory[], exemptPath = ""): Directory[] => {
    const draftRevealsHidden = pathDraft.trim().startsWith(".");
    return entries.filter((entry) => showHidden || draftRevealsHidden || entry.path === exemptPath || !entry.hidden);
  };

  const browse = async (path?: string, nextSelected?: string) => {
    setLoading(true);
    setError(null);
    setCreating(false);
    try {
      const result = await api.browseWorkspaceDirectories(path);
      const parentListing: Listing | null = result.parent
        ? await api.browseWorkspaceDirectories(result.parent)
        : null;
      setCurrentPath(result.path);
      setPathDraft(result.path);
      setParent(result.parent);
      setHome(result.home);
      setCrumbs(result.crumbs ?? []);
      setParents(parentListing?.directories ?? result.directories);
      setChildren(result.directories);
      setTruncated(result.truncated === true || parentListing?.truncated === true);
      setSelected(nextSelected ?? result.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setLoading(false); }
  };

  useEffect(() => {
    if (!open) return;
    void browse();
    dialog.current?.focus();
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !creating) onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); previous?.focus(); };
  }, [open]);

  if (!open) return null;

  const choose = async () => {
    if (!selected || saving) return;
    setSaving(true);
    setError(null);
    try { await onPick(selected); onClose(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  };

  const createFolder = async () => {
    const name = folderName.trim();
    if (!name || !currentPath) return;
    setSaving(true);
    setError(null);
    try {
      const created = await api.createWorkspaceDirectory(currentPath, name);
      setFolderName("");
      await browse(created.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setSaving(false); }
  };

  const parentRows = visible(parents, currentPath);
  const childRows = visible(children, selected);

  return <div className="settings-overlay workspace-picker-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} className="directory-dialog" role="dialog" aria-modal="true" aria-labelledby="directory-title" tabIndex={-1}>
      <header className="directory-dialog__header"><div><h2 id="directory-title">Select Workspace Directory</h2></div><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><Icon name="close" /></button></header>
      <nav className="directory-crumbs" aria-label="Directory path">
        <button type="button" onClick={() => void browse(home || undefined)} aria-current={!parent ? "page" : undefined}>Home</button>
        {crumbs.filter((crumb) => crumb.path !== home && crumb.name !== crumb.path).map((crumb) => <span key={crumb.path}>
          <span aria-hidden="true">/</span>
          <button type="button" onClick={() => void browse(crumb.path)} aria-current={crumb.path === currentPath ? "page" : undefined}>{crumb.name}</button>
        </span>)}
        <button type="button" className="icon-button" aria-label="Edit path" title="Edit path" onClick={() => setEditingPath(true)}><Icon name="more" /></button>
      </nav>
      {editingPath && <form className="directory-location" onSubmit={(event) => { event.preventDefault(); setEditingPath(false); void browse(pathDraft); }}>
        <input autoFocus aria-label="Workspace directory path" value={pathDraft} onChange={(event) => setPathDraft(event.target.value)} />
        <button type="submit" className="icon-button" aria-label="Open path"><Icon name="check" /></button>
      </form>}
      <div className="directory-panes">
        <div className="directory-list" role="listbox" aria-label="Parent directories">
          {parent && <button type="button" role="option" className="directory-row" onClick={() => void browse(parent)}><Icon name="folder" /><span>..</span></button>}
          {parentRows.map((directory) => <button type="button" role="option" key={directory.path} aria-selected={directory.path === currentPath} className={`directory-row${directory.path === currentPath ? " directory-row--selected" : ""}`} onClick={() => void browse(directory.path)}><Icon name="folder" /><span>{directory.name}</span></button>)}
          {!loading && parentRows.length === 0 && <p className="directory-empty">No folders</p>}
        </div>
        <div className="directory-list" role="listbox" aria-label="Directories">
          {childRows.map((directory) => <button type="button" role="option" key={directory.path} aria-selected={directory.path === selected} className={`directory-row${directory.path === selected ? " directory-row--selected" : ""}`} onClick={() => setSelected(directory.path)} onDoubleClick={() => void browse(directory.path)}><Icon name="folder" /><span>{directory.name}</span></button>)}
          {!loading && childRows.length === 0 && <p className="directory-empty">No subfolders</p>}
          {loading && <p className="directory-empty">Loading…</p>}
          {truncated && <p className="directory-empty">This folder has more subfolders than can be shown.</p>}
        </div>
      </div>
      {creating && <form className="directory-create" onSubmit={(event) => { event.preventDefault(); void createFolder(); }}>
        <input autoFocus aria-label="New folder name" placeholder="Folder name" value={folderName} onChange={(event) => setFolderName(event.target.value)} />
        <button type="submit" className="btn btn--primary" disabled={!folderName.trim() || saving}>Create</button>
        <button type="button" className="btn" onClick={() => { setCreating(false); setFolderName(""); }}>Cancel</button>
      </form>}
      {error && <p className="error directory-error" role="alert">{error}</p>}
      <footer className="directory-dialog__footer">
        <button type="button" className="btn" onClick={() => setCreating(true)} disabled={!currentPath || saving}>New folder</button>
        <button type="button" className="btn directory-hidden" aria-pressed={showHidden} onClick={() => setShowHidden((value) => !value)}>Show hidden files</button>
        <span className="directory-dialog__spacer" />
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn--primary" onClick={() => void choose()} disabled={!selected || editingPath || loading || saving}>{saving ? "Adding…" : "Open"}</button>
      </footer>
    </section>
  </div>;
}
