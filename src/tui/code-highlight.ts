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

/**
 * Linear single-pass scan: per-character class tests plus one slice per
 * emitted token. (The previous version took `rest = line.slice(i)` per
 * character and ran token regexes against that suffix — O(line²), which
 * dominated the streaming projection cost for code-heavy messages.)
 * Token boundaries are identical to the previous implementation.
 */
const SH_VAR_CLASS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_{}[]:#%!/-";
const WORD_RUN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_$";

function isWhitespaceChar(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

export function highlightCodeLine(line: string, lang: string): CodeSpan[] {
  const spans: CodeSpan[] = [];
  if (!line) return spans;
  const dialect = dialectFor(lang);
  const hashComment = dialect === "py" || dialect === "sh" || dialect === "generic" || dialect === "json";
  const slashComment = dialect === "js";
  const keywords = KEYWORDS[dialect];
  const length = line.length;
  let i = 0;
  let plainRun = "";
  const flushPlain = () => { if (plainRun) { push(spans, plainRun, "plain"); plainRun = ""; } };

  while (i < length) {
    const ch = line[i]!;
    // comments
    if ((hashComment && ch === "#" && (i === 0 || isWhitespaceChar(line[i - 1] ?? " ")))
      || (slashComment && ch === "/" && (line[i + 1] === "/" || line[i + 1] === "*"))) {
      flushPlain();
      push(spans, line.slice(i), "comment");
      break;
    }
    // strings
    if (ch === '"' || ch === "'" || (ch === "`" && dialect === "js")) {
      flushPlain();
      let j = i + 1;
      while (j < length) {
        const cj = line[j]!;
        if (cj === "\\") { j += 2; continue; }
        if (cj === ch) { j += 1; break; }
        j += 1;
      }
      const literal = line.slice(i, j);
      let k = j;
      while (k < length && isWhitespaceChar(line[k]!)) k += 1;
      const isKey = ch === '"' && line[k] === ":";
      push(spans, literal, isKey ? "property" : "string");
      i = j;
      continue;
    }
    // shell variables / ${} expansions
    if (dialect === "sh" && ch === "$") {
      flushPlain();
      let j = i + 1;
      if (j < length && line[j] === "{") j += 1;
      while (j < length && SH_VAR_CLASS.includes(line[j]!)) j += 1;
      push(spans, line.slice(i, j), "variable");
      i = j;
      continue;
    }
    // numbers (not continuing an identifier)
    if (ch >= "0" && ch <= "9" && !/[A-Za-z0-9_]/.test(line[i - 1] ?? "")) {
      flushPlain();
      let j = i + 1;
      while (j < length) {
        const cj = line[j]!;
        if ((cj >= "0" && cj <= "9") || cj === "." || cj === "_") j += 1;
        else break;
      }
      const exponent = line[j] ?? "";
      if (exponent === "e" || exponent === "E") {
        let k = j + 1;
        if (k < length && (line[k] === "+" || line[k] === "-")) k += 1;
        if (k < length && line[k]! >= "0" && line[k]! <= "9") {
          while (k < length) {
            const ck = line[k]!;
            if (ck >= "0" && ck <= "9") k += 1;
            else break;
          }
          j = k;
        }
      }
      push(spans, line.slice(i, j), "number");
      i = j;
      continue;
    }
    // identifiers
    if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_") {
      let j = i + 1;
      while (j < length && WORD_RUN.includes(line[j]!)) j += 1;
      const word = line.slice(i, j);
      let k = j;
      while (k < length && isWhitespaceChar(line[k]!)) k += 1;
      let kind: CodeTokenKind = "plain";
      if (keywords.has(word)) kind = "keyword";
      else if (line[k] === "(") kind = "function";
      else if (dialect === "py" && line[k] === ":") kind = "property";
      else if (word.charCodeAt(0) >= 65 && word.charCodeAt(0) <= 90) kind = "type";
      else if (line[i - 1] === ".") kind = "property";
      flushPlain();
      push(spans, word, kind);
      i = j;
      continue;
    }
    // operators / punctuation
    if (OPERATOR_CHARS.includes(ch)) {
      flushPlain();
      let j = i + 1;
      while (j < length && OPERATOR_CHARS.includes(line[j]!)) j += 1;
      push(spans, line.slice(i, j), "operator");
      i = j;
      continue;
    }
    plainRun += ch;
    i += 1;
  }
  flushPlain();
  return spans;
}
