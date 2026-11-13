/**
 * Commit-boundary computation for the `document` layout mode.
 *
 * Document mode appends finished content into the terminal's continuous
 * stream (the whole chat — including the composer's current position — is one
 * scrollable document). Streaming text must therefore be emitted progressively
 * as it arrives, but only what is SAFE to freeze: emitted lines can never be
 * rewrapped or revised in the scrollback. The rules mirror terminal-first
 * agents (Antigravity CLI): emit up to the last closed paragraph, and hold
 * back anything whose block syntax is still open.
 */

/**
 * Char offset of the longest prefix of `text` that is safe to append to the
 * stream. Row-stability decides granularity: paragraphs, headings, lists and
 * fenced code all render one stable terminal-row set per source line (code
 * keeps a fixed `│` gutter, one row per line — see markdown-lines), so every
 * COMPLETED line commits as soon as its newline arrives. Only tables are held
 * back: `formatMarkdownTable` aligns columns across the whole block, so a
 * partial table would freeze mis-aligned. The growing last (unterminated)
 * line always stays live.
 */
export function computeCommitBoundary(text: string): number {
  let safeOffset = 0;
  let offset = 0;
  let fenceOpen = false;
  let tableOpen = false;

  for (const line of text.split(/(?<=\n)/)) {
    const terminated = line.endsWith("\n");
    const trimmed = (terminated ? line.slice(0, -1) : line).trim();

    if (!tableOpen && /^(`{3,}|~{3,})/.test(trimmed)) fenceOpen = !fenceOpen;
    const isTableLine = !fenceOpen && trimmed.startsWith("|");
    const closesTable = tableOpen && !isTableLine;
    if (isTableLine) tableOpen = true;
    else if (tableOpen) tableOpen = false; // this line closes the table

    if (!terminated) {
      // The growing line itself never commits; but when it closes an open
      // table, the finished table above it is final and freezes now.
      if (closesTable) safeOffset = offset;
      break;
    }
    offset += line.length;
    // Commit everything whose rendering is final at line granularity; table
    // lines commit with the closing line that follows them.
    if (!tableOpen && !isTableLine) safeOffset = offset;
  }
  return safeOffset;
}

/** Row-text sequences for overlap detection between streamed emissions and the finalized message. */
export function rowTexts(rows: readonly { text: string }[]): string[] {
  return rows.map((row) => row.text);
}

/**
 * Length of the longest common prefix of two row-text sequences — the number
 * of finalized rows already present in the stream (skip them on flush).
 */
export function rowCountledCommitted(finalTexts: readonly string[], committedTexts: readonly string[]): number {
  let count = 0;
  while (count < finalTexts.length && count < committedTexts.length && finalTexts[count] === committedTexts[count]) count += 1;
  return count;
}
