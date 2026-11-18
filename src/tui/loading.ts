import { statusLabel } from "./claude-style.ts";
import { pixelGlyphs } from "./pixel-glyphs.ts";

/** Stable terminal marker used for active work across fonts and renderers. */
export const CLAUDE_SPINNER_FRAMES = ["✻", "✻", "✻", "✻", "✻", "✻", "✻", "✻"] as const;
export const SPINNER_INTERVAL_MS = 240;

/**
 * Full period of the "breathing light" (呼吸灯) pulse: the loading marker fades
 * up and down like an LED without changing width or glyph. Kept far longer than
 * the discrete spinner cadence so the ramp reads as a glow rather than a blink.
 */
export const BREATHING_PERIOD_MS = 2_400;

/** Phase multiplier lands exactly on a bright peak at every multiple of the period. */
const TWO_PI = Math.PI * 2;

/**
 * Smooth 0..1 breathing intensity for a given timestamp.
 *
 * Uses a raised cosine so both ends of the ramp are gentle (no sudden on/off),
 * and so the value crosses 0.5 exactly once per half-period — the same crossing
 * cadence the legacy binary `loadingMarkerBright` used, keeping callers that
 * still branch on a brightness/peak sensible.
 */
export function breathingPhase(now: number): number {
  const t = ((now % BREATHING_PERIOD_MS) + BREATHING_PERIOD_MS) % BREATHING_PERIOD_MS;
  const normalized = t / BREATHING_PERIOD_MS;
  // Map [0,1] -> [0,1] with a peak (1.0) at the middle of the period and 0 at
  // both ends, scaled so the value starts off the floor immediately.
  const raw = 1 - Math.cos(normalized * TWO_PI); // 0..2
  return Math.max(0, Math.min(1, raw / 2));
}

/** Normalize "#rgb"/"#rrggbb"/plain hex to six hex digits; null otherwise. */
function expandHex(color: string): string | null {
  const value = color.replace(/^#/, "").toLowerCase();
  if (value.length === 3) {
    const expanded = value.split("").map((c) => c + c).join("");
    return /^[0-9a-f]{6}$/.test(expanded) ? expanded : null;
  }
  return value.length === 6 && /^[0-9a-f]{6}$/.test(value) ? value : null;
}

/**
 * Linearly interpolate `from` toward `to` by `t` (0..1), returning an `#rrggbb`
 * hex string. When one endpoint is not a plain hex color (themes may use named
 * ANSI colors), it falls back to the other endpoint so the marker never
 * disappears.
 */
export function mixHexColor(from: string, to: string, t: number): string {
  const a = expandHex(from);
  const b = expandHex(to);
  // Fall back to whichever endpoint is a usable color when the other isn't,
  // so breathing never collapses to an undefined marker.
  if (!a && !b) return to || from || "";
  if (!a) return to;
  if (!b) return from;
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  const at = (index: number) => clamp(
    Number.parseInt(a.slice(index, index + 2), 16) * (1 - t)
    + Number.parseInt(b.slice(index, index + 2), 16) * t,
  );
  const red = at(0);
  const green = at(2);
  const blue = at(4);
  return `#${[red, green, blue].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** Breathing marker color: interpolate `dimHex` toward `runningHex` by phase. */
export function breathingColor(
  runningHex: string,
  dimHex: string,
  now: number,
): string {
  return mixHexColor(dimHex, runningHex, breathingPhase(now));
}

/**
 * Color for every part of one live activity row. Using one sample makes marker
 * and text breathe together while preserving the stalled-stream error color.
 */
export function activityRowColor(
  runningHex: string,
  dimHex: string,
  now: number,
  stalled = false,
  errorHex = runningHex,
): string {
  return stalled ? errorHex : breathingColor(runningHex, dimHex, now);
}

/**
 * Frames for the active theme. Pixel themes (`/theme mario-classic`) supply an
 * animated coin spin; every other theme keeps the stable `✻` marker so activity
 * rows never change width mid-turn.
 */
export function spinnerFrames(): readonly string[] {
  return pixelGlyphs()?.spinner ?? CLAUDE_SPINNER_FRAMES;
}

export type SpinnerTimer = {
  setInterval(callback: () => void, delay: number): unknown;
  clearInterval(handle: unknown): void;
};

const defaultSpinnerTimer: SpinnerTimer = {
  setInterval: (callback, delay) => setInterval(callback, delay),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export function getSpinnerFrame(index: number): string {
  const frames = spinnerFrames();
  const normalized = ((index % frames.length) + frames.length) % frames.length;
  return frames[normalized] ?? frames[0]!;
}

/**
 * Normalize the Todo-driven spinner tip into a single user-facing label.
 *
 * The reducer stores the active Todo as `▶ <active form>`; the marker is
 * internal bookkeeping and must not reach the transcript next to the spinner
 * glyph.
 */
export function spinnerTipLabel(message?: string): string | undefined {
  const tip = message?.replace(/^\s*▶\s*/, "").trim();
  if (!tip) return undefined;
  return /[.!?…]$/.test(tip) ? tip : `${tip}…`;
}

/** Convert internal lifecycle text into the one user-facing loading label. */
export function loadingLabel(status: string, spinnerMessage?: string): string {
  const tip = spinnerMessage?.replace(/^\s*▶\s*/, "").trim();
  if (tip) return /[.!?…]$/.test(tip) ? tip : `${tip}…`;
  const normalized = statusLabel(status, true);
  if (normalized !== status.trim()) return normalized;
  return /\.{3}$/.test(status.trim()) ? "Working…" : normalized;
}

/** Small injectable interval wrapper for Ink's loading spinner. */
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
        frame = (frame + 1) % spinnerFrames().length;
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
