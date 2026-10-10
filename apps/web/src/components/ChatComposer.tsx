import { useState } from "react";

export function ChatComposer({
  disabled,
  streaming,
  onSend,
  onStop,
}: {
  disabled: boolean;
  streaming: boolean;
  onSend: (prompt: string) => void;
  onStop: () => void;
}) {
  const [draft, setDraft] = useState("");
  const canSend = !disabled && !streaming && draft.trim().length > 0;

  const submit = (): void => {
    if (!canSend) return;
    onSend(draft.trim());
    setDraft("");
  };

  return (
    <footer className="composer">
      <textarea
        className="composer__input"
        placeholder="Ask the agent… (Enter to send, Shift+Enter for newline)"
        value={draft}
        rows={3}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer__actions">
        {streaming ? (
          <button type="button" className="btn btn--danger" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="button" className="btn btn--primary" onClick={submit} disabled={!canSend}>
            Send
          </button>
        )}
      </div>
    </footer>
  );
}
