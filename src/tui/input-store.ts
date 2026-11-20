/**
 * External prompt-input store for the TUI.
 *
 * Every keystroke used to run through `setInput` state at the top of
 * `AgentSessionApp`, re-rendering the whole tree (feed, status bar, overlays)
 * for a one-character change. The store keeps the canonical value outside
 * React state; only the prompt subtree subscribes via `useSyncExternalStore`.
 * App logic reads and writes through the plain object (refs stay in sync),
 * so the dozens of `setInput(...)` call sites keep working unchanged.
 */
export type InputStore = {
  /** Current prompt text. */
  get(): string;
  /** Replace the prompt text; listeners fire only when the value changes. */
  set(value: string): void;
  /** Subscribe to changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Test/diagnostics hook: number of active subscribers. */
  subscriberCount(): number;
};

export function createInputStore(initial = ""): InputStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: string) => {
      if (next === value) return;
      value = next;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // One broken subscriber must not block the others (React's
          // useSyncExternalStore callback never throws in practice, but the
          // store is also driven directly from command handlers).
        }
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscriberCount: () => listeners.size,
  };
}
