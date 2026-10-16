/**
 * Adapted from OpenAI Codex (Copyright 2025 OpenAI), Apache-2.0:
 * codex-rs/tui/src/{summary_shimmer,motion,status_indicator_widget}.rs
 * Upstream: 6ae8b8aa7c608730d4315d59c5c081897ae02780
 * Modified for TypeScript and the React Web status presentation.
 * License and notices: apps/web/public/licenses/openai-codex/.
 */
export const LOADING_REFRESH_MS = 32;
export const ACTIVITY_INDICATOR_MS = 600;
export const SHIMMER_DELAY_MS = 600;
export const SHIMMER_SWEEP_MS = 1000;
export const SHIMMER_INTERVAL_MS = 4000;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export type LoadingActivity = {
  label: string;
  startedAt: number;
  labelStartedAt: number;
};

export type ShimmerGrapheme = { text: string; alpha: number };

function graphemeWidth(text: string): number {
  // Combining marks and joined emoji stay in one span. Wide clusters occupy
  // two columns, matching the terminal's sweep geometry.
  if (/^[\p{Mark}\u200d\ufe0f]+$/u.test(text)) return 0;
  return /[\p{Extended_Pictographic}\p{Regional_Indicator}\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u.test(text) ? 2 : 1;
}

/** Codex's cosine highlight band, measured over whole grapheme clusters. */
export function loadingShimmer(text: string, elapsedMs: number, reducedMotion = false): ShimmerGrapheme[] {
  if (!text) return [];
  if (reducedMotion) return [{ text, alpha: 1 }];
  const graphemes = Array.from(segmenter.segment(text), ({ segment }) => ({ text: segment, width: graphemeWidth(segment) }));
  const width = graphemes.reduce((sum, grapheme) => sum + grapheme.width, 0);
  const halfWidth = Math.max(width * 0.1, 3);
  const sweep = Math.min(Math.max(0, elapsedMs - SHIMMER_DELAY_MS) % SHIMMER_INTERVAL_MS, SHIMMER_SWEEP_MS);
  const position = sweep / SHIMMER_SWEEP_MS * (width + 2 * halfWidth) - halfWidth;
  let column = 0;
  return graphemes.map((grapheme) => {
    const center = column + grapheme.width / 2;
    column += grapheme.width;
    const distance = Math.min(Math.abs(center - position) / halfWidth, 1);
    const intensity = 0.5 * (1 + Math.cos(Math.PI * distance));
    return { text: grapheme.text, alpha: 0.5 + 0.5 * intensity };
  });
}

export function activityIndicator(elapsedMs: number, reducedMotion = false): string {
  return reducedMotion || Math.floor(Math.max(0, elapsedMs) / ACTIVITY_INDICATOR_MS) % 2 === 0 ? "•" : "◦";
}

export function formatLoadingElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const pad = (value: number) => String(value).padStart(2, "0");
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${pad(Math.floor(seconds % 3600 / 60))}m ${pad(seconds % 60)}s`;
}
