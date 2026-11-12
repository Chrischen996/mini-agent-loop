export type MouseWheelDirection = "up" | "down";

/** Return the wheel direction for an SGR mouse event, if it is a wheel event. */
export function parseSgrMouseWheel(data: string): MouseWheelDirection | undefined {
  const match = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
  if (!match) return undefined;
  const button = Number.parseInt(match[1]!, 10);
  if (button === 64) return "up";
  if (button === 65) return "down";
  return undefined;
}

/**
 * Recognize a complete SGR mouse report so it cannot leak into text input.
 * Accepts both the raw form (\x1b[<...M) and the ESC-stripped form that
 * Ink's useInput passes to handlers ([<...M).
 */
export function isSgrMouseEvent(data: string): boolean {
  return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) || /^\[<\d+;\d+;\d+[Mm]$/.test(data);
}

/**
 * Return the wheel direction for an X10/URXVT (non-SGR) mouse report.
 *
 * Terminals that enable plain mouse tracking (?1000h) but do not support SGR
 * coordinates (?1006h) — e.g. `screen`, older `tmux`, some serial consoles —
 * report the wheel as `ESC [ M Cb` (one coordinate char) or
 * `ESC [ M Cb Cr Cc` (button-extended modes). The button code is offset by
 * +32: '`' (96) is wheel up, 'a' (97) is wheel down.
 *
 * Accepts both the raw form and the ESC-stripped form that Ink's useInput
 * passes to handlers.
 */
export function parseX10MouseWheel(data: string): MouseWheelDirection | undefined {
  const match = /^\x1b?\[M(.{1,3})$/.exec(data);
  if (!match) return undefined;
  const buttonChar = match[1]![0];
  if (buttonChar === "`") return "up";
  if (buttonChar === "a") return "down";
  return undefined;
}

/** Recognize a complete X10/URXVT mouse report so it cannot leak into text input. */
export function isX10MouseEvent(data: string): boolean {
  return /^\x1b?\[M[\x20-\xff]{1,3}$/.test(data);
}

/** Return the wheel direction for any recognized mouse report (SGR or X10). */
export function parseMouseWheel(data: string): MouseWheelDirection | undefined {
  return parseSgrMouseWheel(data) ?? parseX10MouseWheel(data);
}

/** Recognize a complete mouse report (SGR or X10) so it cannot leak into text input. */
export function isMouseEvent(data: string): boolean {
  return isSgrMouseEvent(data) || isX10MouseEvent(data);
}

/**
 * Recognize a complete Kitty keyboard-protocol key report so it cannot leak
 * into text input: `ESC [ <keycode>[;<mods>]u` (raw) or `[<keycode>[;<mods>]u`
 * (ESC-stripped form passed by Ink's useInput).
 */
export function isKittyProtocolKey(data: string): boolean {
  return /^\x1b\[\d+(?:;\d+)?u$/.test(data) || /^\[\d+(?:;\d+)?u$/.test(data);
}

/** Input classification for the streaming mouse-report filter. */
export type TerminalInputKind =
  | { kind: "text"; text: string }
  | { kind: "mouse"; wheel?: MouseWheelDirection };

/** A classified run plus the exact bytes it consumed, for lossless forwarding. */
export type TerminalInputSpan = TerminalInputKind & { raw: string };

// An SGR report payload is digits/semicolons terminated by M or m. The
// "complete" patterns are prefix-matched (no `$`) so several concatenated
// reports in one chunk are consumed one at a time; the "partial" patterns
// match only what could still grow into a report.
const SGR_PARTIAL = /^\x1b?\[<\d{0,6}(?:;\d{0,6}){0,2}/;
const SGR_COMPLETE = /^\x1b?\[<(\d+);(\d+);(\d+)[Mm]/;
// X10 reports are ESC [ M followed by up to three raw bytes ≥ 0x20.
const X10_PARTIAL = /^\x1b?\[M[\x20-\xff]{0,2}/;
const X10_COMPLETE = /^\x1b?\[M([\x20-\xff]{3})/;
// A partial report longer than this cannot be a real report; release as text.
const MAX_REPORT_LENGTH = 24;

function wheelFromSgrButton(button: number): MouseWheelDirection | undefined {
  if (button === 64) return "up";
  if (button === 65) return "down";
  return undefined;
}

function wheelFromX10Button(buttonChar: string): MouseWheelDirection | undefined {
  if (buttonChar === "`") return "up";
  if (buttonChar === "a") return "down";
  return undefined;
}

/**
 * Split one stdin chunk into text runs and complete mouse reports.
 *
 * Raw-mode stdin arrives in arbitrary chunks: a fast trackpad flick delivers
 * several concatenated SGR reports in one read, and a slow terminal (or a busy
 * event loop) can split a single report across reads. Anchored single-report
 * matching fails both ways, which is how `[<64;20;8M` ended up typed into the
 * prompt. This classifier consumes reports byte-by-byte and keeps a partial
 * trailing report pending until its terminator arrives (or a safety cap
 * rejects it as plain text).
 */
export class TerminalInputFilter {
  private pending = "";

  /** Feed one raw stdin chunk; returns the ordered input runs it produced. */
  push(chunk: string): TerminalInputKind[] {
    return this.scan(chunk).map(({ raw: _raw, ...kind }) => kind);
  }

  /**
   * Like `push`, but each run also carries the exact bytes it consumed so a
   * forwarder can re-emit mouse reports verbatim (coordinates included).
   */
  scan(chunk: string): TerminalInputSpan[] {
    const buffer = this.pending + chunk;
    this.pending = "";
    const out: TerminalInputSpan[] = [];
    // Start of the text run not yet emitted; `index` is the scan cursor.
    let textStart = 0;
    let index = 0;

    const flushText = (end: number) => {
      if (end > textStart) {
        const text = buffer.slice(textStart, end);
        out.push({ kind: "text", text, raw: text });
      }
      textStart = end;
    };

    while (index < buffer.length) {
      const rest = buffer.slice(index);

      // SGR mouse report: ESC [ < button ; col ; row M/m
      if (rest.startsWith("\x1b[<") || (rest.startsWith("[<") && index === 0 && this.pendingWasReport)) {
        const complete = SGR_COMPLETE.exec(rest);
        if (complete) {
          flushText(index);
          const button = Number.parseInt(complete[1]!, 10);
          const wheel = wheelFromSgrButton(button);
          out.push({ kind: "mouse", ...(wheel ? { wheel } : {}), raw: complete[0] });
          index += complete[0].length;
          textStart = index;
          this.pendingWasReport = false;
          continue;
        }
        const partial = SGR_PARTIAL.exec(rest);
        if (partial && partial[0].length === rest.length && rest.length <= MAX_REPORT_LENGTH) {
          // Incomplete report at the end of the chunk: hold it for the next read.
          flushText(index);
          this.pending = rest;
          this.pendingWasReport = false;
          return out;
        }
        // Not a report shape — treat the ESC/bracket as text and continue.
        index += 1;
        continue;
      }

      // X10 mouse report: ESC [ M Cb Cr Cc (three bytes ≥ 0x20)
      const x10 = X10_COMPLETE.exec(rest);
      if (x10) {
        flushText(index);
        const wheel = wheelFromX10Button(x10[1]![0]!);
        out.push({ kind: "mouse", ...(wheel ? { wheel } : {}), raw: x10[0] });
        index += x10[0].length;
        textStart = index;
        continue;
      }
      const x10Partial = X10_PARTIAL.exec(rest);
      if (x10Partial && x10Partial[0].length === rest.length) {
        flushText(index);
        this.pending = rest;
        return out;
      }

      index += 1;
    }

    flushText(index);
    return out;
  }

  private pendingWasReport = false;
}

/**
 * Frame a Readable stdin for Ink: mouse reports are re-emitted as one atomic
 * read each, plain text is passed through, and partial reports never leak.
 */
export function filterStdinChunk(chunk: string): string {
  // Single-chunk convenience wrapper used by tests and one-shot consumers.
  return new TerminalInputFilter().push(chunk)
    .map((part) => part.kind === "mouse" ? "\x1b[Z" : part.text)
    .join("");
}
