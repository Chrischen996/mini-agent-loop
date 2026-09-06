import type { ThinkingDisplayMode } from "./state.ts";
import type { RenderLine } from "./render-lines.ts";
import { markdownRowText } from "./markdown-lines.ts";
import { countTerminalRows } from "./terminal-width.ts";

export const THINKING_SUMMARY_LINES = 3;
export const THINKING_MAX_FULL_LINES = 30;

export type ThinkingLineOptions = {
  mode: ThinkingDisplayMode;
  isStreaming?: boolean;
  forceExpanded?: boolean;
  streamInfo?: string;
};

export function thinkingVisibleLines(content: string, options: ThinkingLineOptions): { lines: string[]; truncated: number; expanded: boolean } {
  const all = content.split("\n");
  // Keep the live thinking region to one summary row by default. Full mode
  // remains an explicit opt-in for users who want to inspect reasoning while
  // it streams; completed messages retain the existing summary behavior.
  const streamingCollapse = Boolean(options.isStreaming && !options.forceExpanded && options.mode !== "full");
  const expanded = Boolean(options.forceExpanded || options.mode === "full" || (options.mode === "summary" && !options.isStreaming && all.length <= THINKING_SUMMARY_LINES) || (options.isStreaming && !streamingCollapse && options.mode !== "summary"));
  const limit = expanded ? THINKING_MAX_FULL_LINES : THINKING_SUMMARY_LINES;
  return { lines: all.slice(0, limit), truncated: Math.max(0, all.length - limit), expanded };
}

export function thinkingRenderLines(content: string, options: ThinkingLineOptions): RenderLine[] {
  if (!content || (options.mode === "hidden" && !options.forceExpanded)) return [];
  const visible = thinkingVisibleLines(content, options);
  // The streaming header is the complete live representation in collapsed
  // mode. Do not also emit the first three reasoning lines; doing so makes
  // the terminal tail grow while the summary says it is collapsed.
  if (options.isStreaming && !visible.expanded) return [];
  // Reasoning blocks use the same fenced-code treatment as answer markdown:
  // a `▌` gutter instead of literal ``` markers, one output row per source row
  // so `estimateThinkingRows` keeps matching what is actually rendered.
  let inCode = false;
  const lines = visible.lines.map((text, index) => {
    const fence = text.trimStart().startsWith("```");
    if (fence) {
      const opening = !inCode;
      inCode = opening;
      const lang = opening ? text.trimStart().slice(3).trim() : "";
      return { key: `thinking-${index}`, text: markdownRowText({ kind: "code-fence", text, opening, lang }), style: "thinking", dim: true } satisfies RenderLine;
    }
    const style = inCode ? "muted" : "assistant";
    const body = inCode ? markdownRowText({ kind: "code", text }) : text;
    return { key: `thinking-${index}`, text: body, style, dim: true } satisfies RenderLine;
  });
  if (visible.truncated > 0) {
    lines.push({ key: "thinking-more", text: `··· ${visible.truncated} more ${visible.truncated === 1 ? "line" : "lines"}${options.streamInfo ?? ""}`, style: "thinking", dim: true });
  }
  return lines;
}

/** Keep viewport sizing tied to the exact same visibility decision as render. */
export function estimateThinkingRows(content: string | undefined, options: ThinkingLineOptions & { width: number }): number {
  if (!content || (options.mode === "hidden" && !options.forceExpanded)) return 0;
  const visible = thinkingVisibleLines(content, options);
  // Collapsed thinking is represented by the single `∴ Thinking` hint in the
  // Ink feed. The body is only mounted for expanded/full thinking.
  if (!visible.expanded) return 1;
  const body = visible.lines.join("\n");
  return 1 + countTerminalRows(body, Math.max(10, options.width - 2)) + (visible.truncated > 0 ? 1 : 0);
}
