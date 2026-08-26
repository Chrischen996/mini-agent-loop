export type MarkdownLine =
  | { kind: "code-fence"; text: string }
  | { kind: "code"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "rule" }
  | { kind: "list"; indent: number; ordered: boolean; marker: string; text: string }
  | { kind: "quote"; text: string }
  | { kind: "text"; text: string };

/** Parse Markdown one source line at a time without creating React nodes. */
export function parseMarkdownLines(source: string): MarkdownLine[] {
  const lines = source.split("\n");
  let inCodeBlock = false;
  return lines.map((line) => {
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      return { kind: "code-fence", text: line };
    }
    if (inCodeBlock) return { kind: "code", text: line };
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) return { kind: "heading", level: heading[1]!.length, text: heading[2]! };
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return { kind: "rule" };
    const list = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (list) return { kind: "list", indent: Math.floor(list[1]!.length / 2), ordered: /\d/.test(list[2]!), marker: list[2]!, text: list[3]! };
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) return { kind: "quote", text: quote[1]! };
    return { kind: "text", text: line };
  });
}

