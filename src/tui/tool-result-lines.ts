import { RESULT_GUTTER, type RenderLineTone } from "./render-lines.ts";

export type ToolResultRow = {
  text: string;
  tone?: RenderLineTone;
  dim: boolean;
};

export const TOOL_RESULT_MAX_LINES = 15;

const HUNK_HEADER = /^@@/;
const DIFF_FILE_HEADER = /^(?:diff --git |index |--- |\+\+\+ )/;

/** A tool result carries a unified diff when it has at least one hunk. */
export function isDiffResult(text: string): boolean {
  return text.split("\n").some((line) => HUNK_HEADER.test(line));
}

function classifyDiffLine(line: string): ToolResultRow {
  if (HUNK_HEADER.test(line) || DIFF_FILE_HEADER.test(line)) return { text: line, dim: true };
  if (line.startsWith("+")) return { text: line, tone: "success", dim: false };
  if (line.startsWith("-")) return { text: line, tone: "error", dim: false };
  return { text: line, dim: true };
}

/**
 * One shared row model for tool results.
 *
 * Ink, the ANSI projection and the scrollback transcript all consume this so
 * the same tool result renders identical text everywhere. Diff outputs keep
 * their `+`/`-` lines and gain status tones instead of being flattened to
 * plain text.
 */
export function buildToolResultRows(result: string, maxLines = TOOL_RESULT_MAX_LINES): ToolResultRow[] {
  const source = result.split("\n");
  const visible = source.slice(0, maxLines);
  const diff = isDiffResult(result);
  const rows = visible.map((line) => diff ? classifyDiffLine(line) : { text: line, dim: true } satisfies ToolResultRow);
  if (source.length > visible.length) {
    const remaining = source.length - visible.length;
    rows.push({ text: `… ${remaining} more ${remaining === 1 ? "line" : "lines"}`, dim: true });
  }
  return rows;
}

/** Plain-text form of one row for renderers without color support. */
export function toolResultRowText(row: ToolResultRow): string {
  return `${RESULT_GUTTER}${row.text}`;
}
