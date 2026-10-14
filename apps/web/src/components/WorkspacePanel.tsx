import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { highlightLine } from "../lib/highlight.ts";
import type { WorkspaceEntry, WorkspaceFilePreview } from "../types/api.ts";

type OpenTab = { path: string; name: string };

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** 16px file-type mark. Colour is the glyph's own; folders stay tertiary ink. */
function FileGlyph({ name, dir }: { name: string; dir?: boolean }) {
  if (dir) {
    return (
      <svg className="file-ico file-ico--dir" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M2 3.5h4.2l1.2 1.3H14V13H2V3.5z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  const ext = extOf(name);
  const label = ext === "tsx" || ext === "ts" || ext === "jsx" || ext === "js"
    ? "TS"
    : ext === "json"
      ? "{}"
      : ext === "md"
        ? "M↓"
        : ext === "css"
          ? "#"
          : ext === "html"
            ? "<>"
            : (ext || name).slice(0, 2).toUpperCase();
  return (
    <span className={`file-ico file-ico--${ext || "txt"}`} aria-hidden="true">
      <svg viewBox="0 0 16 16">
        <path d="M4 1.5h5.2L13 5.2V14.5H4z" fill="currentColor" opacity="0.18" />
        <path d="M4 1.5h5.2L13 5.2V14.5H4z" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <path d="M9.2 1.6V5.2H13" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
      <span>{label}</span>
    </span>
  );
}

const PAGE_LINES = 400;
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);

function fileUrl(path: string, sessionId?: string | null, workspaceId?: string): string {
  const query = new URLSearchParams({ path });
  if (sessionId) query.set("sessionId", sessionId);
  else if (workspaceId) query.set("workspaceId", workspaceId);
  return `/api/workspace/raw?${query.toString()}`;
}

function renderInline(text: string): JSX.Element[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={index} className="md-code">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return <span key={index}>{part}</span>;
  });
}

export function WorkspacePanel({ rootPath = "", embedded = false, sessionId, workspaceId }: { rootPath?: string; embedded?: boolean; sessionId?: string | null; workspaceId?: string }) {
  const [entries, setEntries] = useState<WorkspaceEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState(rootPath);
  const [truncated, setTruncated] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, WorkspaceEntry[] | "loading" | "error">>({});
  const [tab, setTab] = useState<OpenTab | null>(null);
  const [preview, setPreview] = useState<WorkspaceFilePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [wrap, setWrap] = useState(true);

  const loadDir = async (path: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listWorkspace(path, sessionId ?? undefined, workspaceId);
      setEntries(data.entries);
      setTruncated(data.truncated);
      setCurrentPath(data.path ?? path);
      setExpanded({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDir(rootPath);
  }, [rootPath, sessionId, workspaceId]);

  const toggleDir = async (entry: WorkspaceEntry): Promise<void> => {
    if (expanded[entry.path]) {
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[entry.path];
        return next;
      });
      return;
    }
    setExpanded((prev) => ({ ...prev, [entry.path]: "loading" }));
    try {
      const data = await api.listWorkspace(entry.path, sessionId ?? undefined, workspaceId);
      setExpanded((prev) => ({ ...prev, [entry.path]: data.entries }));
    } catch {
      setExpanded((prev) => ({ ...prev, [entry.path]: "error" }));
    }
  };

  const loadingMore = useRef(false);

  const openFile = async (entry: WorkspaceEntry): Promise<void> => {
    setTab({ path: entry.path, name: entry.name });
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    try {
      const first = await api.readWorkspaceFile(entry.path, sessionId ?? undefined, workspaceId, { offset: 1, limit: PAGE_LINES });
      setPreview(first.kind === "image" || IMAGE_EXT.has(extOf(entry.name))
        ? { ...first, kind: "image", binary: true }
        : first);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  };

  const loadMore = async (): Promise<void> => {
    if (!tab || !preview || preview.binary || preview.eof || loadingMore.current) return;
    const loaded = preview.content === "" ? 0 : preview.content.split("\n").length;
    loadingMore.current = true;
    try {
      const next = await api.readWorkspaceFile(tab.path, sessionId ?? undefined, workspaceId, {
        offset: preview.startLine + loaded,
        limit: PAGE_LINES,
      });
      setPreview((current) => current && current.path === preview.path
        ? { ...current, content: current.content + (current.content && next.content ? "\n" : "") + next.content, eof: next.eof, truncated: next.truncated }
        : current);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingMore.current = false;
    }
  };

  const crumbs = (tab?.path ?? currentPath).split("/").filter(Boolean);

  return (
    <section className="dock">
      {!embedded && <div className="dock__strip" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === null}
          className={`dock__tab${tab === null ? " dock__tab--on" : ""}`}
          onClick={() => setTab(null)}
        >
          <FileGlyph name="" dir />
          Files
        </button>
        {tab ? (
          <button type="button" role="tab" aria-selected className="dock__tab dock__tab--on">
            <FileGlyph name={tab.name} />
            <span className="dock__tab-name">{tab.name}</span>
            <span
              className="dock__tab-x"
              role="button"
              aria-label="Close file"
              onClick={(event) => {
                event.stopPropagation();
                setTab(null);
                setPreview(null);
                setPreviewError(null);
              }}
            >
              ×
            </span>
          </button>
        ) : null}
      </div>}

      {tab === null ? (
        <div className="dock__pane">
          <header className="dock__head">
            <p className="path-label" title={currentPath || "/"}>
              <span className="path-label__dir">workspace</span>
              {crumbs.map((part) => (
                <span key={part}>
                  <span className="path-label__sep">/</span>
                  <span className="path-label__tail">{part}</span>
                </span>
              ))}
            </p>
            <button type="button" className="dock__tool" onClick={() => void loadDir(currentPath)} aria-label="Reload">
              ↻
            </button>
          </header>
          <div className="tree">
            {loading && !entries ? <p className="tree__note">Loading…</p> : null}
            {error ? <p className="tree__note tree__note--error">{error}</p> : null}
            {entries && entries.length === 0 && !error ? <p className="tree__note">Empty directory.</p> : null}
            {entries ? (
              <Level
                entries={entries}
                depth={0}
                expanded={expanded}
                onToggle={(entry) => void toggleDir(entry)}
                onOpen={(entry) => void openFile(entry)}
              />
            ) : null}
            {truncated ? <p className="tree__note">Showing the first {entries?.length ?? 0} entries.</p> : null}
          </div>
        </div>
      ) : (
        <div className="dock__pane preview">
          <header className="dock__head">
            <p className="path-label" title={tab.path}>
              {tab.path.split("/").slice(0, -1).filter(Boolean).map((part) => (
                <span key={part} className="path-label__dir">{part}/</span>
              ))}
              <span className="path-label__tail">{tab.name}</span>
            </p>
            <span className="preview__lang">{extOf(tab.name) || "txt"}</span>
            {embedded && <button type="button" className="dock__tool" aria-label="Back to files" onClick={() => setTab(null)}>Files</button>}
            <button
              type="button"
              className={`dock__tool${wrap ? " dock__tool--on" : ""}`}
              aria-pressed={wrap}
              onClick={() => setWrap((value) => !value)}
            >
              Wrap
            </button>
          </header>
          {previewLoading ? (
            <p className="preview__empty">Reading…</p>
          ) : previewError ? (
            <div className="preview__empty">
              <p>{previewError}</p>
              <button type="button" className="btn" onClick={() => void openFile({ ...tab, type: "file" })}>
                Retry
              </button>
            </div>
          ) : preview?.kind === "image" ? (
            <div className="preview__image">
              <img src={fileUrl(tab.path, sessionId, workspaceId)} alt={tab.name} />
            </div>
          ) : preview?.binary ? (
            <p className="preview__empty">This file can’t be previewed.</p>
          ) : (
            <>
              {preview?.truncated ? <p className="preview__banner">Showing the first 512 KB.</p> : null}
              <PreviewBody
                name={tab.name}
                content={preview?.content ?? ""}
                startLine={preview?.startLine ?? 1}
                wrap={wrap}
                eof={preview?.eof !== false}
                onNearEnd={() => void loadMore()}
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}

function PreviewBody({
  name,
  content,
  startLine,
  wrap,
  eof,
  onNearEnd,
}: {
  name: string;
  content: string;
  startLine: number;
  wrap: boolean;
  eof: boolean;
  onNearEnd: () => void;
}) {
  const ext = extOf(name);
  const markdown = ext === "md" || ext === "markdown";
  const lines = content === "" ? [] : content.split("\n");
  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    if (!eof && el.scrollHeight - el.scrollTop - el.clientHeight < 80) onNearEnd();
  };
  return (
    <div className={`preview__body${wrap ? " preview__body--wrap" : ""}${markdown ? " preview__body--md" : ""}`} onScroll={onScroll}>
      {markdown
        ? lines.map((line, index) => <MarkdownLine key={index} line={line} />)
        : lines.map((line, index) => (
          <div className="preview__line" key={index}>
            <span className="preview__gutter">{startLine + index}</span>
            <code>
              {highlightLine(line, ext).map((span, spanIndex) => (
                <span key={spanIndex} className={span.tone === "plain" ? undefined : `tok tok--${span.tone}`}>{span.text || " "}</span>
              ))}
              {line === "" ? " " : null}
            </code>
          </div>
        ))}
      {!eof ? <p className="preview__more">Loading more…</p> : null}
    </div>
  );
}

function MarkdownLine({ line }: { line: string }) {
  if (line.startsWith("```")) return <div className="md-fence">{line}</div>;
  const heading = /^(#{1,4})\s+(.*)$/.exec(line);
  if (heading) {
    const level = heading[1].length;
    return <div className={`md-h md-h${level}`}>{renderInline(heading[2])}</div>;
  }
  if (/^\s*[-*]\s+/.test(line)) return <div className="md-li">{renderInline(line.replace(/^\s*[-*]\s+/, ""))}</div>;
  if (line.trim() === "") return <div className="md-blank" />;
  return <div className="md-p">{renderInline(line)}</div>;
}

function Level({
  entries,
  depth,
  expanded,
  onToggle,
  onOpen,
}: {
  entries: WorkspaceEntry[];
  depth: number;
  expanded: Record<string, WorkspaceEntry[] | "loading" | "error">;
  onToggle: (entry: WorkspaceEntry) => void;
  onOpen: (entry: WorkspaceEntry) => void;
}) {
  return (
    <ul className="tree__level" style={depth > 0 ? { paddingLeft: 18 } : undefined}>
      {entries.map((entry) => {
        const child = expanded[entry.path];
        const open = entry.type === "dir" && child !== undefined;
        return (
          <li key={entry.path} className="tree__item">
            <button
              type="button"
              className={`tree__row${open ? " tree__row--open" : ""}`}
              onClick={() => (entry.type === "dir" ? onToggle(entry) : onOpen(entry))}
              title={entry.path}
            >
              <FileGlyph name={entry.name} dir={entry.type === "dir"} />
              <span className="tree__name">{entry.name}</span>
            </button>
            {child === "loading" ? <p className="tree__note">Loading…</p> : null}
            {child === "error" ? <p className="tree__note tree__note--error">Could not list this directory.</p> : null}
            {Array.isArray(child) ? (
              child.length === 0 ? (
                <p className="tree__note">Empty directory.</p>
              ) : (
                <Level entries={child} depth={depth + 1} expanded={expanded} onToggle={onToggle} onOpen={onOpen} />
              )
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
