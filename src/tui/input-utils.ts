/** Strip terminal control chars while keeping newlines, tabs, and Unicode text. */
export function sanitizeInput(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export type FileAcTrigger = {
  fragment: string;
  replaceFn: (chosen: string) => string;
};

/** Path atom: letters (incl. CJK), digits, and common filename punctuation. */
const PATH_ATOM_RE = /[\p{L}\p{N}._/\\()+\-]+/uy;

export function extractFileAcTrigger(input: string): FileAcTrigger | null {
  const atTrigger = extractAtFileAcTrigger(input);
  if (atTrigger) return atTrigger;

  // /read|/ls|/find|/grep followed by a (possibly empty) path/pattern fragment.
  const slashMatch = input.match(/^\/(read|ls|find|grep)\s+(.*)$/i);
  if (slashMatch) {
    const fragment = slashMatch[2];
    const prefixLen = input.length - fragment.length;
    return {
      fragment,
      replaceFn: (chosen) => input.slice(0, prefixLen) + chosen,
    };
  }

  const bareTrigger = extractBareFileAcTrigger(input);
  if (bareTrigger) return bareTrigger;

  return null;
}

export function extractBareFileAcTrigger(input: string): FileAcTrigger | null {
  const fragment = input.trim();
  if (!fragment) return null;
  if (/^\//.test(fragment)) return null;
  if (fragment.includes("@")) return null;
  if (/\s/.test(fragment)) return null;
  if (!/^[\p{L}\p{N}._/\\()+\-]+$/u.test(fragment)) return null;
  if (!/[\p{L}\p{N}]/u.test(fragment)) return null;
  // Keep bare fragments eligible for direct completion. The async candidate
  // lookup decides whether a matching file exists, so normal prose still
  // produces no visible picker while names such as `app` remain completable.
  return {
    fragment,
    replaceFn: (chosen) => chosen,
  };
}

/** Collect every @path token; skip email-like word@word. */
export function parseAtRefs(input: string): string[] {
  const refs: string[] = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] !== "@" || !isTokenStart(input, i)) continue;
    const path = takeAtPath(input, i + 1);
    if (path) refs.push(path);
    i += path.length;
  }
  return refs;
}

export type AcMode =
  | "command"
  | "file"
  | "model"
  | "model-picker"
  | "session-list"
  | "model-setup"
  | "profile-name"
  | "profile-list"
  | null;

/** Enter accepts a candidate only for list-style autocomplete modes. */
export function shouldAcceptAutocompleteOnEnter(acMode: AcMode): boolean {
  return acMode === "command"
    || acMode === "file"
    || acMode === "model"
    || acMode === "model-picker"
    || acMode === "session-list";
}

function extractAtFileAcTrigger(input: string): FileAcTrigger | null {
  // @path at a token boundary. Allow trailing spaces while the user is still
  // typing a spaced filename, but do not swallow later sentence text.
  const atIdx = input.lastIndexOf("@");
  if (atIdx >= 0 && isTokenStart(input, atIdx)) {
    const after = input.slice(atIdx + 1);
    const path = takeAtPath(input, atIdx + 1);
    const rest = after.slice(path.length);
    if (rest === "" || /^[ \t]+$/.test(rest)) {
      return {
        fragment: after,
        replaceFn: (chosen) => input.slice(0, atIdx) + "@" + chosen,
      };
    }
  }
  return null;
}

function isTokenStart(input: string, index: number): boolean {
  return index === 0 || /\s/.test(input[index - 1]!);
}

/** Read one @ref: first atom, then space-separated pieces that still look like a path. */
function takeAtPath(input: string, start: number): string {
  const first = matchPathAtom(input, start);
  if (!first) return "";
  let end = start + first.length;

  while (end < input.length && isSpace(input[end]!)) {
    let next = end + 1;
    while (next < input.length && isSpace(input[next]!)) next++;
    const atom = matchPathAtom(input, next);
    if (!atom || !isPathContinuation(atom)) break;
    end = next + atom.length;
  }

  return input.slice(start, end);
}

function matchPathAtom(input: string, start: number): string {
  if (start >= input.length) return "";
  PATH_ATOM_RE.lastIndex = start;
  const match = PATH_ATOM_RE.exec(input);
  return match && match.index === start ? match[0] : "";
}

/** Continue after a space only for filename-like pieces, not English words. */
function isPathContinuation(atom: string): boolean {
  return /[./\\()+]|\P{ASCII}/u.test(atom);
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t";
}
