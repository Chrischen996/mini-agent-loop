import type { StreamPhase } from "../lib/event-adapter.ts";

export function StatusBar({
  connected,
  sessionTitle,
  model,
  streaming,
  phase,
}: {
  connected: "checking" | "connected" | "disconnected";
  sessionTitle: string | null;
  model: string | null;
  streaming: boolean;
  phase: StreamPhase;
}) {
  return (
    <footer className="statusbar">
      <span className={`chip chip--${connected}`}>{connected}</span>
      {sessionTitle ? <span className="muted">{sessionTitle}</span> : null}
      {model ? <span className="muted">Model: {model}</span> : null}
      {streaming ? <span className="muted">Task: {phase}</span> : null}
    </footer>
  );
}
