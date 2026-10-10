import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import type { ChatItem, StreamPhase } from "../lib/event-adapter.ts";

function renderNote(item: Extract<ChatItem, { kind: "note" }>): JSX.Element {
  return (
    <div key={item.id} className={`note note--${item.tone}`}>
      {item.text}
    </div>
  );
}

function renderTool(item: Extract<ChatItem, { kind: "tool" }>): JSX.Element {
  return (
    <div key={item.id} className={`tool tool--${item.status}`}>
      <div className="tool__head">
        <span className="tool__name">{item.name}</span>
        <span className="tool__status">{item.status}</span>
      </div>
      {item.preview ? <pre className="tool__preview">{item.preview}</pre> : null}
    </div>
  );
}

function renderPermission(item: Extract<ChatItem, { kind: "permission" }>, {
  sessionId,
  onResolved,
}: { sessionId: string; onResolved: (requestId: string) => void }): JSX.Element {
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
        <p className="muted" style={{ margin: "4px 0 0" }}>
          {item.status === "resolved" ? "Resolved." : "Pending approval."}
        </p>
      )}
    </div>
  );
}

function renderItem(
  item: ChatItem,
  opts: { sessionId: string; onResolved: (requestId: string) => void },
): JSX.Element {
  switch (item.kind) {
    case "user":
      return (
        <div key={item.id} className="msg msg--user">
          {item.text}
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
          <div className="msg__body">{item.text}</div>
          {item.streaming ? <span className="msg__caret">▍</span> : null}
        </div>
      );
    case "tool":
      return renderTool(item);
    case "permission":
      return renderPermission(item, opts);
    case "note":
      return renderNote(item);
  }
}

export function ChatView({
  items,
  phase,
  sessionTitle,
  sessionId,
  onPermissionResolve,
}: {
  items: ChatItem[];
  phase: StreamPhase;
  sessionTitle: string | null;
  sessionId: string | null;
  onPermissionResolve: (requestId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const opts = { sessionId: sessionId ?? "", onResolved: onPermissionResolve };

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, phase]);

  return (
    <section className="panel panel--chat">
      <div className="panel__head">
        <h2>Conversation</h2>
        {sessionTitle ? <span className="muted">{sessionTitle}</span> : null}
        <span className={`chip chip--${phase}`}>{phase}</span>
      </div>
      <div className="chat" ref={scrollRef}>
        {items.length === 0 ? (
          <p className="muted">Send a message to start the conversation.</p>
        ) : (
          items.map((item) => renderItem(item, opts))
        )}
      </div>
    </section>
  );
}
