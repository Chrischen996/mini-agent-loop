import type { ChatItem } from "../lib/event-adapter.ts";
import { ToolCallCard } from "./ToolCallCard.tsx";

export function ToolActivityPanel({ items }: { items: ChatItem[] }) {
  const tools = items.filter(
    (item): item is Extract<ChatItem, { kind: "tool" }> => item.kind === "tool",
  );
  const running = tools.filter((tool) => tool.status === "running").length;

  return (
    <aside className="panel panel--tools">
      <div className="panel__head">
        <h2>Tool Activity</h2>
        {running > 0 ? <span className="chip chip--running">{running} running</span> : null}
      </div>
      {tools.length === 0 ? (
        <p className="muted">No tool calls yet.</p>
      ) : (
        <div className="tool-stack">
          {tools.map((tool) => <ToolCallCard key={tool.id} item={tool} />)}
        </div>
      )}
    </aside>
  );
}
