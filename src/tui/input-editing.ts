const graphemeSegmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

export function splitGraphemes(value: string): string[] {
  if (!value) return [];
  if (graphemeSegmenter) {
    return [...graphemeSegmenter.segment(value)].map((part) => part.segment);
  }
  return [...value];
}

export function clampCursor(cursor: number, length: number): number {
  return Math.max(0, Math.min(cursor, length));
}

export function lineBounds(parts: readonly string[], cursor: number): { start: number; end: number } {
  const safeCursor = clampCursor(cursor, parts.length);
  let start = safeCursor;
  while (start > 0 && parts[start - 1] !== "\n") start--;
  let end = safeCursor;
  while (end < parts.length && parts[end] !== "\n") end++;
  return { start, end };
}

export function moveToLineStart(parts: readonly string[], cursor: number): number {
  return lineBounds(parts, cursor).start;
}

export function moveToLineEnd(parts: readonly string[], cursor: number): number {
  return lineBounds(parts, cursor).end;
}

function isWhitespace(grapheme: string | undefined): boolean {
  return Boolean(grapheme && /^\s$/u.test(grapheme));
}

export function moveWordLeft(parts: readonly string[], cursor: number): number {
  let next = clampCursor(cursor, parts.length);
  while (next > 0 && isWhitespace(parts[next - 1])) next--;
  while (next > 0 && !isWhitespace(parts[next - 1])) next--;
  return next;
}

export function moveWordRight(parts: readonly string[], cursor: number): number {
  let next = clampCursor(cursor, parts.length);
  while (next < parts.length && isWhitespace(parts[next])) next++;
  while (next < parts.length && !isWhitespace(parts[next])) next++;
  while (next < parts.length && isWhitespace(parts[next])) next++;
  return next;
}

export function moveVertical(
  parts: readonly string[],
  cursor: number,
  direction: -1 | 1,
  preferredColumn?: number,
): { cursor: number; preferredColumn: number } {
  const { start, end } = lineBounds(parts, cursor);
  const column = preferredColumn ?? clampCursor(cursor, parts.length) - start;
  if (direction < 0) {
    if (start === 0) return { cursor: clampCursor(cursor, parts.length), preferredColumn: column };
    const previousEnd = start - 1;
    let previousStart = previousEnd;
    while (previousStart > 0 && parts[previousStart - 1] !== "\n") previousStart--;
    return { cursor: Math.min(previousStart + column, previousEnd), preferredColumn: column };
  }
  if (end >= parts.length) return { cursor: clampCursor(cursor, parts.length), preferredColumn: column };
  const nextStart = end + 1;
  let nextEnd = nextStart;
  while (nextEnd < parts.length && parts[nextEnd] !== "\n") nextEnd++;
  return { cursor: Math.min(nextStart + column, nextEnd), preferredColumn: column };
}
