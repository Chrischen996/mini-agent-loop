import { terminalStringWidth } from "./terminal-width.ts";

export type MarkdownLine =
  | { kind: "code-fence"; text: string; opening: boolean; lang: string }
  | { kind: "code"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "rule" }
  | { kind: "list"; indent: number; ordered: boolean; marker: string; text: string }
  | { kind: "quote"; text: string }
  | { kind: "table"; text: string; role: "header" | "rule" | "body" }
  | { kind: "text"; text: string };

/** Vertical gutter that marks fenced code without echoing the ``` markers. */
export const CODE_GUTTER = "▌";

/**
 * Remove inline Markdown decoration for renderers that only have one styled
 * terminal string per row. The Ink renderer applies richer inline styles, but
 * the ANSI projection should never expose protocol-like `**markers**` to the
 * user when it cannot represent the spans independently.
 */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

/**
 * Plain-text form of one parsed Markdown row.
 *
 * Both clients share this so the ANSI projection and the Ink components cannot
 * drift on markers: fenced code keeps its row budget (one output row per source
 * line, which `estimateMessageHeight` relies on) while losing the literal ```
 * lines, headings get the same `▸`/`·` bullet, and tables arrive pre-aligned.
 */
export function markdownRowText(line: MarkdownLine): string {
  switch (line.kind) {
    case "code-fence":
      return line.opening && line.lang ? `${CODE_GUTTER} ${line.lang}` : CODE_GUTTER;
    case "code":
      return `${CODE_GUTTER} ${line.text}`;
    case "heading":
      return `${line.level <= 2 ? "▸" : "·"} ${stripInlineMarkdown(line.text)}`;
    case "rule":
      return "";
    case "quote":
      return `│ ${stripInlineMarkdown(line.text)}`;
    case "table":
    case "text":
      return line.text;
    case "list":
      return `${line.ordered ? line.marker : "•"} ${stripInlineMarkdown(line.text)}`;
  }
}

/** Horizontal rule for a Markdown `---`, clamped to the available width. */
export function markdownRuleText(width?: number, max = 48): string {
  if (width === undefined) return "─".repeat(max);
  return "─".repeat(Math.max(1, Math.min(max, width - 2)));
}

type TableAlignment = "left" | "right" | "center";

/** GFM delimiter row: `| --- | :-: | --: |`. A pipe is required so that a
 *  heading followed by a `---` rule is not mistaken for a two-column table. */
const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function isTableDelimiter(line: string): boolean {
  return line.includes("|") && TABLE_DELIMITER_RE.test(line);
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => stripInlineMarkdown(cell.trim()));
}

function cellAlignments(delimiter: string[]): TableAlignment[] {
  return delimiter.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

function padCell(cell: string, width: number, align: TableAlignment): string {
  const padding = Math.max(0, width - terminalStringWidth(cell));
  if (align === "right") return `${" ".repeat(padding)}${cell}`;
  if (align === "center") {
    const left = Math.floor(padding / 2);
    return `${" ".repeat(left)}${cell}${" ".repeat(padding - left)}`;
  }
  return `${cell}${" ".repeat(padding)}`;
}

/**
 * Align one GitHub-flavoured Markdown table into terminal rows.
 *
 * `rows[0]` is the header and `rows[1]` is the `| --- | --- |` delimiter, which
 * becomes a per-column rule instead of being shown literally. Column widths are
 * shared by every row, so the cells line up the way the author intended.
 */
export function formatMarkdownTable(rows: string[]): MarkdownLine[] {
  const cells = rows.map(splitTableRow);
  const header = cells[0] ?? [];
  const alignments = cellAlignments(cells[1] ?? header.map(() => "---"));
  const columnCount = Math.max(header.length, ...cells.slice(2).map((row) => row.length), 1);
  const widths: number[] = [];
  for (let column = 0; column < columnCount; column++) {
    widths.push(Math.max(3, ...cells.map((row) => terminalStringWidth(row[column] ?? ""))));
  }
  // Per-cell padding must survive: only the trailing edge of the whole row is
  // trimmed, otherwise the second and later columns lose their alignment.
  const join = (values: string[]) =>
    values.map((value, index) => padCell(value, widths[index] ?? terminalStringWidth(value), alignments[index] ?? "left")).join("  ").trimEnd();

  const lines: MarkdownLine[] = [
    { kind: "table", role: "header", text: join(header) },
    { kind: "table", role: "rule", text: widths.map((width) => "─".repeat(width)).join("  ") },
  ];
  for (const row of cells.slice(2)) {
    const padded = Array.from({ length: columnCount }, (_, index) => row[index] ?? "");
    lines.push({ kind: "table", role: "body", text: join(padded) });
  }
  return lines;
}

/**
 * Recognize one row of a Markdown table.
 *
 * `headerPipeLed` keeps the table's own style: when the header starts with `|`
 * a following prose line that merely mentions a pipe (`use a | b`) ends the
 * table instead of being absorbed into it as another cell.
 */
function isTableRow(line: string, headerPipeLed: boolean): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|") || isTableDelimiter(trimmed)) return false;
  return headerPipeLed ? trimmed.startsWith("|") : true;
}

/** Parse Markdown one source line at a time without creating React nodes. */
export function parseMarkdownLines(source: string): MarkdownLine[] {
  const lines = source.split("\n");
  const parsed: MarkdownLine[] = [];
  let inCodeBlock: boolean = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trimStart().startsWith("```")) {
      const opening: boolean = !inCodeBlock;
      inCodeBlock = opening;
      const lang = opening ? line.trimStart().slice(3).trim() : "";
      parsed.push({ kind: "code-fence", text: line, opening, lang });
      index++;
      continue;
    }
    if (inCodeBlock) {
      parsed.push({ kind: "code", text: line });
      index++;
      continue;
    }
    // A table starts with a row followed by the `| --- | --- |` delimiter.
    if (isTableRow(line, line.trim().startsWith("|")) && isTableDelimiter(lines[index + 1] ?? "")) {
      const headerPipeLed = line.trim().startsWith("|");
      const table = [line, lines[index + 1]!];
      index += 2;
      while (index < lines.length && isTableRow(lines[index]!, headerPipeLed)) {
        table.push(lines[index]!);
        index++;
      }
      parsed.push(...formatMarkdownTable(table));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      parsed.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      index++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      parsed.push({ kind: "rule" });
      index++;
      continue;
    }
    const list = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (list) {
      parsed.push({ kind: "list", indent: Math.floor(list[1]!.length / 2), ordered: /\d/.test(list[2]!), marker: list[2]!, text: list[3]! });
      index++;
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      parsed.push({ kind: "quote", text: quote[1]! });
      index++;
      continue;
    }
    parsed.push({ kind: "text", text: line });
    index++;
  }
  return parsed;
}
