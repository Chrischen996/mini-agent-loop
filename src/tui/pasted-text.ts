/** Mirror claude-code history pasted-text refs. */
export type PastedTextRef = {
  id: number;
  text: string;
  lines: number;
};

let nextPastedId = 1;

export function formatPastedTextRef(id: number, lines: number): string {
  if (lines <= 0) return `[Pasted text #${id}]`;
  return `[Pasted text #${id} +${lines} lines]`;
}

export function countLines(text: string): number {
  return (text.match(/\r\n|\r|\n/g) || []).length;
}

export function extractPastedTextRefs(input: string) {
  const re = /\[(Pasted text|Image|\.\.\.Truncated text) #(\d+)(?: \+\d+ lines)?(\.)*\]/g;
  const refs: Array<{ match: string; id: number; index: number }> = [];
  for (const m of input.matchAll(re)) {
    refs.push({ match: m[0], id: parseInt(m[2] ?? "0", 10), index: m.index ?? 0 });
  }
  return refs;
}

export function expandPastedTextRefs(
  input: string,
  pastedContents: Record<number, string>,
): string {
  const refs = extractPastedTextRefs(input);
  let expanded = input;
  for (let i = refs.length - 1; i >= 0; i--) {
    const r = refs[i];
    const content = pastedContents[r.id];
    if (content === undefined) continue;
    expanded = expanded.slice(0, r.index) + content + expanded.slice(r.index + r.match.length);
  }
  return expanded;
}

export function tryReplaceLongPaste(
  value: string,
  pastedContents: Record<number, string>,
  threshold = 800,
): { display: string; updatedContents: Record<number, string>; longPaste: boolean } {
  if (value.length < threshold) {
    return { display: value, updatedContents: pastedContents, longPaste: false };
  }
  const id = nextPastedId++;
  const lines = countLines(value);
  pastedContents = { ...pastedContents, [id]: value };
  return { display: formatPastedTextRef(id, lines), updatedContents: pastedContents, longPaste: true };
}
