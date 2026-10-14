/** Small lexer for the file preview. Not a language parser — just enough
 *  to colour the shapes harness's code preview distinguishes. */

export type Tone = "comment" | "string" | "keyword" | "number" | "plain";

export type Span = { tone: Tone; text: string };

const KEYWORDS = new Set(
  `if else for while return function const let var class import export from
   type interface extends implements new this async await try catch throw
   switch case break continue default of in yield typeof instanceof
   public private protected static readonly package void int string bool
   true false null undefined def fn mut pub struct enum impl match
   select from where and or not as`.split(/\s+/),
);

const CODE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "scss", "json", "html", "py",
  "go", "rs", "java", "c", "h", "cpp", "cc", "sh", "bash", "yml", "yaml", "toml",
  "sql", "vue", "svelte",
]);

export function isCodeExt(ext: string): boolean {
  return CODE_EXT.has(ext);
}

export function highlightLine(line: string, ext: string): Span[] {
  if (!isCodeExt(ext) || ext === "md") return [{ tone: "plain", text: line }];
  const spans: Span[] = [];
  const push = (tone: Tone, text: string) => {
    if (!text) return;
    const last = spans[spans.length - 1];
    if (last && last.tone === tone) last.text += text;
    else spans.push({ tone, text });
  };
  let i = 0;
  const hashComment = ext === "py" || ext === "sh" || ext === "bash" || ext === "yml" || ext === "yaml" || ext === "toml";
  while (i < line.length) {
    const rest = line.slice(i);
    if (rest.startsWith("//") || (hashComment && rest.startsWith("#")) || rest.startsWith("--")) {
      push("comment", rest);
      break;
    }
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      let j = 1;
      while (j < rest.length) {
        if (rest[j] === "\\") { j += 2; continue; }
        if (rest[j] === quote) { j += 1; break; }
        j += 1;
      }
      push("string", rest.slice(0, j));
      i += j;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (word) {
      push(KEYWORDS.has(word[0]) ? "keyword" : "plain", word[0]);
      i += word[0].length;
      continue;
    }
    const num = /^(?:0x[\da-fA-F]+|\d+(?:\.\d+)?)/.exec(rest);
    if (num) {
      push("number", num[0]);
      i += num[0].length;
      continue;
    }
    push("plain", rest[0]);
    i += 1;
  }
  return spans.length ? spans : [{ tone: "plain", text: line }];
}
