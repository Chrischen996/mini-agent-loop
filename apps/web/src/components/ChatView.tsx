import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api.ts";
import type { ChatItem, StreamPhase } from "../lib/event-adapter.ts";
import { Icon } from "./Icon.tsx";
import { LoadingIndicator } from "./LoadingIndicator.tsx";
import type { LoadingActivity } from "../lib/loading.ts";

function renderNote(
  item: Extract<ChatItem, { kind: "note" }>,
  onContinue?: () => void,
): JSX.Element {
  return (
    <div key={item.id} className={`note note--${item.tone}`}>
      <span style={{ whiteSpace: "pre-line" }}>{item.text}</span>
      {item.action === "continue" && onContinue && (
        <button
          type="button"
          className="note__action-btn"
          style={{
            marginLeft: "12px",
            padding: "2px 10px",
            background: "var(--color-primary, #0969da)",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            fontWeight: 500,
            fontSize: "12px",
          }}
          title="使用默认策略分配新预算并从检查点继续"
          onClick={onContinue}
        >
          继续执行（新预算）
        </button>
      )}
    </div>
  );
}

function inlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const tokenPattern = /(`[^`\n]+`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_)/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = tokenPattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={`${keyPrefix}-code-${index}`}>{token.slice(1, -1)}</code>);
    } else if (match[2] && match[3]) {
      const href = /^(https?:|mailto:|#)/i.test(match[3]) ? match[3] : undefined;
      nodes.push(href ? <a key={`${keyPrefix}-link-${index}`} href={href} target={href.startsWith("#") ? undefined : "_blank"} rel={href.startsWith("#") ? undefined : "noreferrer"}>{match[2]}</a> : match[2]);
    } else if (match[4] || match[5]) {
      nodes.push(<strong key={`${keyPrefix}-strong-${index}`}>{match[4] ?? match[5]}</strong>);
    } else {
      nodes.push(<em key={`${keyPrefix}-em-${index}`}>{match[6] ?? match[7]}</em>);
    }
    cursor = match.index + token.length;
    index += 1;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function AssistantMarkdown({ text }: { text: string }): JSX.Element {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let ordered = false;
  let code: string[] | null = null;
  let codeLanguage = "";

  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    blocks.push(<p key={`p-${blocks.length}`}>{inlineMarkdown(paragraph.join("\n"), `p-${blocks.length}`)}</p>);
    paragraph = [];
  };
  const flushList = (): void => {
    if (!list.length) return;
    const items = list.map((item, index) => <li key={`li-${index}`}>{inlineMarkdown(item, `li-${blocks.length}-${index}`)}</li>);
    blocks.push(ordered ? <ol key={`ol-${blocks.length}`}>{items}</ol> : <ul key={`ul-${blocks.length}`}>{items}</ul>);
    list = [];
  };
  const flushCode = (): void => {
    if (code === null) return;
    blocks.push(<pre key={`pre-${blocks.length}`}><code data-language={codeLanguage || undefined}>{code.join("\n")}</code></pre>);
    code = null;
    codeLanguage = "";
  };

  lines.forEach((line) => {
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      if (code === null) {
        flushParagraph();
        flushList();
        code = [];
        codeLanguage = fence[1] ?? "";
      } else {
        flushCode();
      }
      return;
    }
    if (code !== null) {
      code.push(line);
      return;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      return;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      flushList();
      const Tag = `h${heading[1].length}` as keyof JSX.IntrinsicElements;
      blocks.push(<Tag key={`h-${blocks.length}`}>{inlineMarkdown(heading[2], `h-${blocks.length}`)}</Tag>);
      return;
    }
    const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || numbered) {
      flushParagraph();
      if (list.length && ordered !== Boolean(numbered)) flushList();
      ordered = Boolean(numbered);
      list.push((unordered ?? numbered)?.[1] ?? "");
      return;
    }
    if (/^\s*>\s?/.test(line)) {
      flushList();
      paragraph.push(line.replace(/^\s*>\s?/, ""));
      return;
    }
    flushList();
    paragraph.push(line);
  });

  if (code !== null) flushCode();
  flushParagraph();
  flushList();
  return <div className="markdown">{blocks.length ? blocks : <span>{text}</span>}</div>;
}

function toolTitle(name: string): string {
  const labels: Record<string, string> = {
    read: "Read",
    bash: "Bash",
    write: "Write",
    edit: "Edit",
    grep: "Grep",
    search: "Search",
  };
  return labels[name.trim().toLowerCase()] ?? name;
}

function splitReadNotice(preview: string): { body: string; notice?: string } {
  const match = preview.match(/\n\n\[notice: ([\s\S]+)\]\s*$/);
  if (!match || match.index === undefined) return { body: preview };
  return { body: preview.slice(0, match.index), notice: match[1] };
}

function numberedPreview(preview: string, startLine = 1): string {
  const { body, notice } = splitReadNotice(preview.replace(/\r\n?/g, "\n"));
  const lines = body.split("\n");
  const width = String(startLine + Math.max(lines.length - 1, 0)).length;
  const numbered = lines
    .map((line, index) => `${String(startLine + index).padStart(width, " ")}  ${line}`)
    .join("\n");
  return notice ? `${numbered}\n\n${notice}` : numbered;
}

function renderTool(item: Extract<ChatItem, { kind: "tool" }>): JSX.Element {
  const isRead = item.name.trim().toLowerCase() === "read";
  const summary = isRead ? item.path : undefined;
  const body = item.preview
    ? isRead
      ? numberedPreview(item.preview, item.startLine ?? 1)
      : item.preview
    : "";
  return (
    <div key={item.id} className={`tool tool--${item.status}${isRead ? " tool--read" : ""}`}>
      <div className="tool__head">
        <span className="tool__name">{isRead ? "Read" : toolTitle(item.name)}</span>
        {summary ? (
          <>
            <span className="tool__sep" aria-hidden="true" />
            <span className="tool__summary" title={summary}>{summary}</span>
          </>
        ) : null}
        <span className="tool__status">{item.status}</span>
      </div>
      {body ? (
        isRead ? (
          <details className="tool__details">
            <summary>File</summary>
            <pre className="tool__preview tool__preview--lines">{body}</pre>
          </details>
        ) : (
          <pre className="tool__preview">{body}</pre>
        )
      ) : null}
    </div>
  );
}

function PermissionCard({ item, sessionId, onResolved }: { item: Extract<ChatItem, { kind: "permission" }>; sessionId: string; onResolved: (requestId: string) => void }): JSX.Element {
  const [resolving, setResolving] = useState(false);
  const handleDecision = async (decision: "allow" | "deny"): Promise<void> => {
    if (!sessionId || resolving) return;
    setResolving(true);
    try {
      await api.resolvePermission(sessionId, item.requestId, decision);
      onResolved(item.requestId);
    } catch (err) {
      console.error("permission resolve failed", err);
    } finally {
      setResolving(false);
    }
  };
  return (
    <div key={item.id} className={`perm perm--${item.status}`}>
      <strong>Permission required</strong> — tool <code>{item.tool}</code>
      {item.risk ? <span className="perm__risk"> ({item.risk})</span> : null}
      {item.status === "pending" && sessionId ? (
        <div className="perm__actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={resolving}
            onClick={() => void handleDecision("allow")}
          >
            Allow
          </button>
          <button
            type="button"
            className="btn btn--danger"
            disabled={resolving}
            onClick={() => void handleDecision("deny")}
          >
            Deny
          </button>
        </div>
      ) : (
        <p className="muted perm__status">
          {item.status === "resolved" ? "Resolved." : "Pending approval."}
        </p>
      )}
    </div>
  );
}

function renderItem(
  item: ChatItem,
  opts: {
    sessionId: string;
    onResolved: (requestId: string) => void;
    onContinue?: () => void;
  },
): JSX.Element {
  switch (item.kind) {
    case "user":
      return (
        <div key={item.id} className="msg msg--user">
          <div className="msg__bubble">
            {item.text && <div>{item.text}</div>}
            {item.attachments && item.attachments.length > 0 && <div className="msg__attachments">{item.attachments.map((name) => <span className="msg__attachment" key={name}><Icon name={/\.(png|jpe?g|gif|webp)$/i.test(name) ? "image" : "file"} width={14} height={14} />{name}</span>)}</div>}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div key={item.id} className={`msg msg--assistant ${item.streaming ? "msg--streaming" : ""}`}>
          {item.reasoning ? (
            <details className="msg__reasoning">
              <summary>Reasoning</summary>
              <pre>{item.reasoning}</pre>
            </details>
          ) : null}
          <AssistantMarkdown text={item.text} />
          {item.streaming ? <span className="msg__caret">▍</span> : null}
        </div>
      );
    case "tool":
      return renderTool(item);
    case "permission":
      return <PermissionCard key={item.id} item={item} {...opts} />;
    case "note":
      return renderNote(item, opts.onContinue);
  }
}

export function ChatView({
  items,
  phase,
  sessionTitle,
  sessionId,
  onPermissionResolve,
  onContinue,
  activity,
  onStop,
}: {
  items: ChatItem[];
  phase: StreamPhase;
  sessionTitle: string | null;
  sessionId: string | null;
  onPermissionResolve: (requestId: string) => void;
  onContinue?: () => void;
  activity?: LoadingActivity | null;
  onStop?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followTailRef = useRef(true);
  const [showToBottom, setShowToBottom] = useState(false);
  const opts = { sessionId: sessionId ?? "", onResolved: onPermissionResolve, onContinue };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && followTailRef.current) {
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    }
  }, [items, phase]);

  useEffect(() => {
    followTailRef.current = true;
    setShowToBottom(false);
    const el = scrollRef.current;
    if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }, [sessionId]);

  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const following = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
    followTailRef.current = following;
    setShowToBottom(!following && el.scrollHeight > el.clientHeight + 72);
  };

  const scrollToBottom = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    followTailRef.current = true;
    setShowToBottom(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <section className="panel panel--chat">
      <div className="panel__head">
        <h2>Conversation</h2>
        {sessionTitle ? <span className="muted">{sessionTitle}</span> : null}
        <span className={`chip chip--${phase}`}>{phase}</span>
      </div>
      <div className="chat-shell">
        <div className="chat" ref={scrollRef} onScroll={handleScroll}>
          <div className="chat__column">
            {items.length > 0 ? items.map((item) => renderItem(item, opts)) : null}
            {activity && <LoadingIndicator key={activity.startedAt} activity={activity} onStop={onStop} />}
          </div>
        </div>
        {showToBottom && <button type="button" className="chat__to-bottom" aria-label="Jump to latest message" title="Jump to latest message" onClick={scrollToBottom}><Icon name="chevronDown" width={16} height={16} /></button>}
      </div>
    </section>
  );
}
