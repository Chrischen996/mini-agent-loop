import type { ThinkingDisplayMode } from "./state.ts";
import type { RenderLine } from "./render-lines.ts";
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
  const streamingCollapse = Boolean(options.isStreaming && !options.forceExpanded && options.mode !== "full" && all.length > 15);
  const expanded = Boolean(options.forceExpanded || options.mode === "full" || (options.mode === "summary" && !options.isStreaming && all.length <= THINKING_SUMMARY_LINES) || (options.isStreaming && !streamingCollapse && options.mode !== "summary"));
  const limit = expanded ? THINKING_MAX_FULL_LINES : THINKING_SUMMARY_LINES;
  return { lines: all.slice(0, limit), truncated: Math.max(0, all.length - limit), expanded };
}

export function thinkingRenderLines(content: string, options: ThinkingLineOptions): RenderLine[] {
  if (!content || (options.mode === "hidden" && !options.forceExpanded)) return [];
  const visible = thinkingVisibleLines(content, options);
  let inCode = false;
  const lines = visible.lines.map((text, index) => {
    const fence = text.trimStart().startsWith("```");
    const style = fence ? "thinking" : inCode ? "muted" : "assistant";
    if (fence) inCode = !inCode;
    return { key: `thinking-${index}`, text, style, dim: true } satisfies RenderLine;
  });
  if (visible.truncated > 0) {
    lines.push({ key: "thinking-more", text: `··· ${visible.truncated} more lines${options.streamInfo ?? ""}`, style: "thinking", dim: true });
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
