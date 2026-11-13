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
 * stream: everything up to (and including) the last blank line that is not
 * inside an open ``` fence and is followed by settled state. Tables commit
 * with the blank line that closes them; a trailing unclosed block stays in
 * the live frame until the message finalizes.
 */
export function computeCommitBoundary(text: string): number {
  let safeOffset = 0;
  let offset = 0;
  let fenceOpen = false;
  let inTable = false;

  for (const line of text.split(/(?<=\n)/)) {
    const terminated = line.endsWith("\n");
    const body = line.slice(0, -1).trimEnd();
    const trimmed = body.trim();

    if (/^(`{3,}|~{3,})/.test(trimmed)) fenceOpen = !fenceOpen;
    const lineIsTable = !fenceOpen && trimmed.startsWith("|");
    if (lineIsTable) inTable = true;
    else if (trimmed !== "" || !fenceOpen) {
      // Any non-table line outside a fence (blank lines included) ends the
      // table run; the blank line then commits the closed table.
      inTable = false;
    }

    offset += line.length;

    // A paragraph boundary we may freeze at: blank line, outside any fence,
    // with no table still in progress.
    if (terminated && trimmed === "" && !fenceOpen && !inTable) safeOffset = offset;
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
