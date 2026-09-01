import { sanitizeInput } from "./input-utils.ts";
import { TerminalInputHistory } from "./terminal-input-history.ts";

export type TerminalInputAction =
  | { type: "submit"; value: string }
  | { type: "insert"; value: string }
  | { type: "backspace" }
  | { type: "cursor"; direction: "left" | "right" | "up" | "down" }
  | { type: "tab" }
  | { type: "scroll"; delta: number }
  | { type: "cancel" }
  | { type: "exit" }
  | { type: "shortcut"; name: "copy" | "paste-image" | "permission" | "thinking-level" | "thinking-mode" | "thinking-message" | "focus-message" | "bottom" | "todo"; direction?: "increase" | "decrease" };

export type TerminalInputControllerOptions = {
  onAction: (action: TerminalInputAction) => void;
  getScrollPageSize?: () => number;
};

/** Raw stdin controller for the standalone ANSI TUI entrypoint. */
export class TerminalInputController {
  private value = "";
  private cursor = 0;
  private readonly onAction: (action: TerminalInputAction) => void;
  private readonly getScrollPageSize: () => number;
  private pendingEscape = "";
  private preferredColumn: number | undefined;
  private readonly history: TerminalInputHistory;

  constructor(options: TerminalInputControllerOptions) {
    this.onAction = options.onAction;
    this.getScrollPageSize = options.getScrollPageSize ?? (() => 10);
    this.history = new TerminalInputHistory();
  }

  getValue(): string { return this.value; }
  getCursor(): number { return this.cursor; }
  clear(): void {
    this.value = "";
    this.cursor = 0;
    this.pendingEscape = "";
    this.preferredColumn = undefined;
    this.history.resetNavigation();
  }
  setValue(value: string, cursor = graphemes(value).length): void {
    this.value = value;
    this.cursor = Math.max(0, Math.min(graphemes(value).length, cursor));
    this.pendingEscape = "";
    this.preferredColumn = undefined;
    this.history.resetNavigation();
  }

  /** Add an accepted prompt/command without coupling input to Agent history. */
  recordSubmission(value: string): void {
    this.history.add(value);
  }

  /** Recall a previous single-line submission. Returns false when scrolling should win. */
  navigateHistory(direction: -1 | 1): boolean {
    if (this.hasNewline()) return false;
    const next = this.history.navigate(direction, this.value);
    if (next === undefined) return false;
    this.value = next;
    this.cursor = graphemes(next).length;
    this.pendingEscape = "";
    this.preferredColumn = undefined;
    return true;
  }

  getHistory(): readonly string[] {
    return this.history.getEntries();
  }

  hasNewline(): boolean {
    return this.value.includes("\n");
  }

  /** Move within a multi-line draft while preserving the requested column. */
  moveVertical(direction: -1 | 1): boolean {
    const parts = graphemes(this.value);
    if (!parts.includes("\n")) return false;
    const { start, end } = lineBounds(parts, this.cursor);
    const column = this.preferredColumn ?? this.cursor - start;
    if (direction < 0) {
      if (start === 0) return true;
      const previousEnd = start - 1;
      let previousStart = previousEnd;
      while (previousStart > 0 && parts[previousStart - 1] !== "\n") previousStart--;
      this.cursor = Math.min(previousStart + column, previousEnd);
    } else {
      if (end >= parts.length) return true;
      const nextStart = end + 1;
      let nextEnd = nextStart;
      while (nextEnd < parts.length && parts[nextEnd] !== "\n") nextEnd++;
      this.cursor = Math.min(nextStart + column, nextEnd);
    }
    this.preferredColumn = column;
    return true;
  }

  handle(data: string): void {
    const input = this.pendingEscape + data;
    this.pendingEscape = "";
    let index = 0;
    while (index < input.length) {
      const rest = input.slice(index);
      const sequence = this.handleEscape(rest);
      if (sequence === -1) {
        this.pendingEscape = rest;
        break;
      }
      if (sequence > 0) { index += sequence; continue; }
      const code = input.codePointAt(index) ?? 0;
      const char = String.fromCodePoint(code);
      if (code === 3) this.emit({ type: "exit" });
      else if (code === 13) this.submit();
      else if (code === 10) this.insert("\n");
      else if (code === 127 || code === 8) this.backspace();
      else if (code === 25) this.emit({ type: "shortcut", name: "copy" });
      else if (code === 22) this.emit({ type: "shortcut", name: "paste-image" });
      else if (code === 18) this.emit({ type: "shortcut", name: "thinking-level" });
      else if (code === 20) this.emit({ type: "shortcut", name: "thinking-mode" });
      else if (code === 7) this.emit({ type: "shortcut", name: "bottom" });
      else if (char === "\t") this.emit({ type: "tab" });
      else if (code >= 32) this.insert(sanitizeInput(char));
      index += char.length;
    }
  }

  private handleEscape(value: string): number {
    if (value === "\x1b") {
      this.emit({ type: "cancel" });
      return 1;
    }
    if (value === "\x1b[" || value === "\x1b[1;2" || value === "\x1b[5") return -1;
    if (value.startsWith("\x1b.") || value.startsWith("\x1b,")) {
      this.emit({ type: "shortcut", name: "thinking-level", direction: value[1] === "." ? "increase" : "decrease" });
      return 2;
    }
    if (value.startsWith("\x1bt") || value.startsWith("\x1bT")) {
      this.emit({ type: "shortcut", name: "thinking-message" });
      return 2;
    }
    if (!value.startsWith("\x1b[")) {
      // A standalone Esc can arrive in the same read as the next printable
      // character. Treat the unknown sequence as Esc + normal input so cancel
      // still reaches the overlay instead of silently dropping the key.
      if (value.startsWith("\x1b")) {
        this.emit({ type: "cancel" });
        return 1;
      }
      return 0;
    }
    const match = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(value);
    if (!match) return -1;
    const params = match[1] ?? "";
    const final = match[2];
    if (final === "D") this.move(-1);
    else if (final === "C") this.move(1);
    // Kitty keyboard protocol preserves the Shift modifier for Ctrl+Shift+T
    // as CSI 116;6u. A few xterm-compatible terminals use modifyOtherKeys
    // instead, so accept that encoding and the common CSI 1;6T variant too.
    else if (final === "u" && params === "116;6") this.emit({ type: "shortcut", name: "todo" });
    else if (final === "~" && params === "27;6;116") this.emit({ type: "shortcut", name: "todo" });
    else if (final === "T" && params === "1;6") this.emit({ type: "shortcut", name: "todo" });
    // xterm/modern terminals encode Alt+Arrow as CSI 1;3A/B. Kitty-style
    // keyboard protocols may use 1;9A/B, so accept both forms.
    else if ((params === "1;3" || params === "1;9") && final === "A") this.emit({ type: "shortcut", name: "focus-message", direction: "decrease" });
    else if ((params === "1;3" || params === "1;9") && final === "B") this.emit({ type: "shortcut", name: "focus-message", direction: "increase" });
    else if (final === "A" && params === "1;2") this.emit({ type: "shortcut", name: "thinking-level", direction: "increase" });
    else if (final === "B" && params === "1;2") this.emit({ type: "shortcut", name: "thinking-level", direction: "decrease" });
    else if (final === "A") {
      if (this.hasNewline()) this.emit({ type: "cursor", direction: "up" });
      else this.emit({ type: "scroll", delta: 1 });
    }
    else if (final === "B") {
      if (this.hasNewline()) this.emit({ type: "cursor", direction: "down" });
      else this.emit({ type: "scroll", delta: -1 });
    }
    else if (final === "H") this.cursor = 0;
    else if (final === "F") this.cursor = graphemes(this.value).length;
    else if (final === "~" && params === "5") this.emit({ type: "scroll", delta: this.getScrollPageSize() });
    else if (final === "~" && params === "6") this.emit({ type: "scroll", delta: -this.getScrollPageSize() });
    else if (final === "Z") this.emit({ type: "shortcut", name: "permission" });
    return match[0].length;
  }

  private insert(value: string): void {
    const parts = graphemes(this.value);
    const inserted = graphemes(value);
    parts.splice(this.cursor, 0, ...inserted);
    this.value = parts.join("");
    this.cursor += inserted.length;
    this.preferredColumn = undefined;
    this.history.resetNavigation();
    this.emit({ type: "insert", value: this.value });
  }

  private backspace(): void {
    if (this.cursor === 0) return;
    const parts = graphemes(this.value);
    parts.splice(this.cursor - 1, 1);
    this.cursor--;
    this.value = parts.join("");
    this.preferredColumn = undefined;
    this.history.resetNavigation();
    this.emit({ type: "backspace" });
  }

  private move(direction: -1 | 1): void {
    this.cursor = Math.max(0, Math.min(graphemes(this.value).length, this.cursor + direction));
    this.preferredColumn = undefined;
    this.emit({ type: "cursor", direction: direction < 0 ? "left" : "right" });
  }

  private submit(): void {
    const submitted = this.value;
    this.emit({ type: "submit", value: submitted });
    // Submit handlers may synchronously replace the value (for example when
    // opening the model picker). Do not erase that programmatic transition.
    if (this.value !== submitted) return;
    this.value = "";
    this.cursor = 0;
  }

  private emit(action: TerminalInputAction): void { this.onAction(action); }
}

function graphemes(value: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return [...segmenter.segment(value)].map((part) => part.segment);
  }
  return [...value];
}

function lineBounds(parts: string[], cursor: number): { start: number; end: number } {
  let start = cursor;
  while (start > 0 && parts[start - 1] !== "\n") start--;
  let end = cursor;
  while (end < parts.length && parts[end] !== "\n") end++;
  return { start, end };
}
