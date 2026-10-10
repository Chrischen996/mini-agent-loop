import type { ChatItem } from "../lib/event-adapter.ts";

export function ToolActivityPanel({ items }: { items: ChatItem[] }) {
  const tools = items.filter(
    (item): item is Extract<ChatItem, { kind: "tool" }> => item.kind === "tool",
  );
  const running = tools.filter((tool) => tool.status === "running");
  const finished = tools.filter((tool) => tool.status !== "running");

  return (
    <aside className="panel panel--tools">
      <div className="panel__head">
        <h2>Tool Activity</h2>
        {running.length > 0 ? <span className="chip chip--running">{running.length} running</span> : null}
      </div>
      {tools.length === 0 ? (
        <p className="muted">No tool calls yet.</p>
      ) : (
        <ul className="list">
          {running.map((tool) => (
            <li key={tool.id} className="row row--tool">
              <span className="row__title">{tool.name}</span>
              <span className="muted">running…</span>
            </li>
          ))}
          {finished.map((tool) => (
            <li key={tool.id} className={`row row--tool row--${tool.status}`}>
              <span className="row__title">{tool.name}</span>
              <span className="muted">{tool.status}</span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
