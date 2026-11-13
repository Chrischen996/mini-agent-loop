/**
 * Line-level source highlighting for fenced code blocks, mirroring the token
 * semantics of gemini-cli's highlight.js theme blocks (hljs-keyword /
 * hljs-string / hljs-number / hljs-comment / hljs-title.function /
 * hljs-type / hljs-attr / hljs-variable / hljs-operator map 1:1 onto the
 * kinds below). Colors resolve through the live theme palette AT PAINT TIME,
 * so `/theme` switches recolor code instantly without rebuilding rows.
 *
 * The lexer is per-line and deliberately simple: a regex scanner over
 * comments/strings/numbers/identifiers/operators, language-aware only in its
 * keyword set and comment/string syntax. Long-lived contexts (multi-line
 * strings, block comments) degrade to plain — same trade-off every
 * streaming terminal renderer makes when lines commit independently.
 */
import { TUI_COLORS as C } from "./theme.ts";

export type CodeTokenKind =
  | "gutter"
  | "keyword"
  | "string"
  | "number"
  | "comment"
  | "function"
  | "type"
  | "property"
  | "variable"
  | "operator"
  | "plain";

export type CodeSpan = { text: string; kind: CodeTokenKind };

/** Resolve a token kind to its live palette color. */
export function codeTokenColor(kind: CodeTokenKind): string {
  switch (kind) {
    case "gutter": return C.gutter;
    case "keyword": return C.info;
    case "string": return C.running;
    case "number": return C.success;
    case "comment": return C.muted;
    case "function": return C.planMode;
    case "type": return C.thinking;
    case "property": return C.user;
    case "variable": return C.thinking;
    case "operator": return C.muted;
    case "plain": return C.assistant;
  }
}

/** Attribute decorations per kind (comments read dim like gemini's hljs). */
export function codeTokenAttrs(kind: CodeTokenKind): { dim?: boolean; italic?: boolean } {
  return kind === "comment" ? { dim: true, italic: true } : {};
}

type Dialect = "js" | "py" | "sh" | "json" | "generic";

function dialectFor(lang: string): Dialect {
  const l = lang.toLowerCase().trim();
  if (["ts", "tsx", "typescript", "js", "jsx", "javascript", "java", "c", "cpp", "cs", "go", "rust", "swift", "kotlin", "scala"].includes(l)) return "js";
  if (["py", "python"].includes(l)) return "py";
  if (["sh", "bash", "zsh", "shell", "console", "ps1", "powershell"].includes(l)) return "sh";
  if (["json", "jsonc"].includes(l)) return "json";
  return "generic";
}

const KEYWORDS: Record<Dialect, ReadonlySet<string>> = {
  js: new Set("const let var function return if else for while do switch case default new class extends super this import export from as await async yield try catch finally throw typeof instanceof in of delete void static get set null undefined true false break continue interface type enum implements public private protected readonly abstract".split(" ")),
  py: new Set("def class return if elif else for while import from as pass break continue try except finally raise with in is not and or None True False lambda yield global nonlocal async await self".split(" ")),
  sh: new Set("if then else elif fi for while do done case esac function in echo export local return set shift source alias".split(" ")),
  json: new Set("true false null".split(" ")),
  generic: new Set(),
};

const OPERATOR_CHARS = "=+*/%<>!&|^~?:;,-";

function push(spans: CodeSpan[], text: string, kind: CodeTokenKind): void {
  if (!text) return;
  const last = spans[spans.length - 1];
  if (last && last.kind === kind) last.text += text;
  else spans.push({ text, kind });
}

export function highlightCodeLine(line: string, lang: string): CodeSpan[] {
  const spans: CodeSpan[] = [];
  if (!line) return spans;
  const dialect = dialectFor(lang);
  const hashComment = dialect === "py" || dialect === "sh" || dialect === "generic" || dialect === "json";
  const slashComment = dialect === "js";
  const keywords = KEYWORDS[dialect];
  let i = 0;
  let plainRun = "";
  const flushPlain = () => { if (plainRun) { push(spans, plainRun, "plain"); plainRun = ""; } };

  while (i < line.length) {
    const ch = line[i]!;
    const rest = line.slice(i);
    // comments
    if ((hashComment && ch === "#" && (i === 0 || /\s/.test(line[i - 1] ?? " ")))
      || (slashComment && (rest.startsWith("//") || rest.startsWith("/*")))) {
      flushPlain();
      push(spans, rest, "comment");
      break;
    }
    // strings
    if (ch === '"' || ch === "'" || (ch === "`" && dialect === "js")) {
      flushPlain();
      let j = 1;
      while (j < rest.length) {
        if (rest[j] === "\\") { j += 2; continue; }
        if (rest[j] === ch) { j += 1; break; }
        j += 1;
      }
      const literal = rest.slice(0, j);
      const isKey = ch === '"' && /^\s*:/.test(rest.slice(j));
      push(spans, literal, isKey ? "property" : "string");
      i += j;
      continue;
    }
    // shell variables / ${} expansions
    if (dialect === "sh" && ch === "$") {
      flushPlain();
      const m = rest.match(/^[$][{]?[A-Za-z_0-9{}[\]:#%!/-]*[}]?|^[$][@*?$#!-]/);
      push(spans, m ? m[0] : "$", "variable");
      i += m ? m[0].length : 1;
      continue;
    }
    // numbers (not continuing an identifier)
    if (/[0-9]/.test(ch) && !/[A-Za-z0-9_]/.test(line[i - 1] ?? "")) {
      flushPlain();
      const m = rest.match(/^[0-9][0-9_.]*(?:[eE][+-]?[0-9]+)?|[0-9][0-9a-fA-F_.]*/);
      push(spans, m ? m[0] : ch, "number");
      i += m ? m[0].length : 1;
      continue;
    }
    // identifiers
    if (/[A-Za-z_]/.test(ch)) {
      const m = rest.match(/^[A-Za-z_$][\w$]*/)!;
      const word = m[0];
      const after = rest.slice(word.length);
      let kind: CodeTokenKind = "plain";
      if (keywords.has(word)) kind = "keyword";
      else if (/^\s*\(/.test(after)) kind = "function";
      else if (dialect === "py" && /^\s*:/.test(after)) kind = "property";
      else if (/^[A-Z]/.test(word)) kind = "type";
      else if (line[i - 1] === ".") kind = "property";
      flushPlain();
      push(spans, word, kind);
      i += word.length;
      continue;
    }
    // operators / punctuation
    if (OPERATOR_CHARS.includes(ch)) {
      flushPlain();
      const m = rest.match(new RegExp(`^[${OPERATOR_CHARS}]+`));
      push(spans, m ? m[0] : ch, "operator");
      i += m ? m[0].length : 1;
      continue;
    }
    plainRun += ch;
    i += 1;
  }
  flushPlain();
  return spans;
}
