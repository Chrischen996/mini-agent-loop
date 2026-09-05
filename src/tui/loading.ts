import { statusLabel } from "./claude-style.ts";

/** Claude Code's lightweight glyph animation used for active work. */
export const CLAUDE_SPINNER_FRAMES = ["✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳"] as const;
export const SPINNER_INTERVAL_MS = 80;

export type SpinnerTimer = {
  setInterval(callback: () => void, delay: number): unknown;
  clearInterval(handle: unknown): void;
};

const defaultSpinnerTimer: SpinnerTimer = {
  setInterval: (callback, delay) => setInterval(callback, delay),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export function getSpinnerFrame(index: number): string {
  const normalized = ((index % CLAUDE_SPINNER_FRAMES.length) + CLAUDE_SPINNER_FRAMES.length) % CLAUDE_SPINNER_FRAMES.length;
  return CLAUDE_SPINNER_FRAMES[normalized] ?? CLAUDE_SPINNER_FRAMES[0];
}

/** Convert internal lifecycle text into the one user-facing loading label. */
export function loadingLabel(status: string, spinnerMessage?: string): string {
  const tip = spinnerMessage?.replace(/^\s*▶\s*/, "").trim();
  if (tip) return /[.!?…]$/.test(tip) ? tip : `${tip}…`;
  const normalized = statusLabel(status, true);
  if (normalized !== status.trim()) return normalized;
  return /\.{3}$/.test(status.trim()) ? "Working…" : normalized;
}

/** Small injectable interval wrapper shared by the ANSI and Ink entries. */
export function createSpinnerTicker(
  onFrame: (frame: number) => void,
  timer: SpinnerTimer = defaultSpinnerTimer,
): { start(): void; stop(): void; reset(): void } {
  let frame = 0;
  let running = false;
  let handle: unknown;

  return {
    start() {
      if (running) return;
      running = true;
      onFrame(frame);
      handle = timer.setInterval(() => {
        frame = (frame + 1) % CLAUDE_SPINNER_FRAMES.length;
        onFrame(frame);
      }, SPINNER_INTERVAL_MS);
    },
    stop() {
      if (!running) return;
      running = false;
      timer.clearInterval(handle);
      handle = undefined;
    },
    reset() {
      frame = 0;
    },
  };
}
