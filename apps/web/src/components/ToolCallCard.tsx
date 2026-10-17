import { useState } from "react";
import type { ChatItem } from "../lib/event-adapter.ts";
import { toolCard } from "../lib/tool-card.ts";
import { Icon } from "./Icon.tsx";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

const ICONS = {
  read: "file",
  bash: "terminal",
  search: "search",
  mutate: "edit",
  generic: "activity",
} as const;

/** One Harness-style tool row plus its expandable result card. */
export function ToolCallCard({ item }: { item: ToolItem }): JSX.Element {
  const card = toolCard(item);
  const [open, setOpen] = useState(false);
  const expanded = open && card.expandable;
  const summaryClass = `tool__summary${card.summaryTone === "error" ? " tool__summary--error" : ""}`;
  const row = (
    <>
      <span className="tool__glyph" aria-hidden="true"><Icon name={ICONS[card.kind]} width={16} height={16} /></span>
      <span className="tool__title">{card.title}</span>
      {card.summary ? (
        <>
          <span className="tool__sep" aria-hidden="true" />
          <span className={summaryClass} title={card.summary}>{card.summary}</span>
        </>
      ) : <span className="tool__summary" />}
      {card.suffix ? <span className="tool__suffix">{card.suffix}</span> : null}
      <span className="u-hidden">{card.statusLabel}</span>
    </>
  );

  return (
    <div className={`tool tool--${card.kind} tool--${item.status}`} data-tool={item.name}>
      {card.expandable ? (
        <button type="button" className="tool__row" aria-expanded={expanded} onClick={() => setOpen((value) => !value)}>
          {row}
        </button>
      ) : (
        <div className="tool__row">{row}</div>
      )}
      {expanded ? <ToolBody card={card} failed={item.status === "error"} /> : null}
    </div>
  );
}

function ToolBody({ card, failed }: { card: ReturnType<typeof toolCard>; failed: boolean }): JSX.Element {
  if (card.kind === "read" && card.lines) {
    return (
      <div className="tool__card">
        <div className="tool__card-caption">File</div>
        <ol className="tool__lines">
          {card.lines.map((line) => (
            <li key={line.number} data-line={line.number}><code>{line.text || " "}</code></li>
          ))}
        </ol>
        {card.notice ? <p className="tool__notice">{card.notice}</p> : null}
      </div>
    );
  }
  if (card.kind === "bash") {
    return (
      <div className="tool__terminal">
        {card.command ? <div className="tool__terminal-banner">{card.command}</div> : null}
        {card.output ? <pre className="tool__terminal-out" data-error={failed || undefined}>{card.output}</pre> : null}
      </div>
    );
  }
  if (card.kind === "mutate" && card.changes?.length) {
    return (
      <div className="tool__card">
        <ul className="tool__changes">
          {card.changes.map((change, index) => (
            <li key={`${change.kind}-${index}`} className={`tool__change tool__change--${change.kind}`}>
              <span className="tool__change-mark" aria-hidden="true">{change.kind === "added" ? "+" : "−"}</span>
              <span>{change.text}</span>
            </li>
          ))}
        </ul>
        {card.output ? <pre className="tool__plain" data-error={failed || undefined}>{card.output}</pre> : null}
      </div>
    );
  }
  if (card.kind === "search" && card.output) {
    const rows = card.output.replace(/\r\n?/g, "\n").split("\n").filter((line) => line.length > 0);
    return (
      <div className="tool__card">
        <ul className="tool__matches">
          {rows.map((line, index) => <li key={index}>{line}</li>)}
        </ul>
      </div>
    );
  }
  return (
    <div className="tool__io">
      {card.input ? (
        <div className="tool__io-section">
          <span className="tool__io-label">IN</span>
          <pre>{card.input}</pre>
        </div>
      ) : null}
      {card.input && card.output ? <div className="tool__io-divider" /> : null}
      {card.output ? (
        <div className="tool__io-section">
          <span className="tool__io-label">OUT</span>
          <pre data-error={failed || undefined}>{card.output}</pre>
        </div>
      ) : null}
    </div>
  );
}
