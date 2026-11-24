import type { WriteStream } from "node:tty";
import type { RenderLine } from "./render-lines.ts";
import { formatRenderLine } from "./render-line-format.ts";
import { truncateTerminalText } from "./terminal-width.ts";
import { bootProbe } from "./boot-trace.ts";
import { recordFramePaint, recordRowRepaint } from "./perf-monitor.ts";
import type { TuiLayoutMode } from "./layout-mode.ts";

const ANSI_ERASE_LINE = "\x1b[2K";
const ANSI_CLEAR_TERMINAL = "\x1b[2J";
const DISABLE_AUTOWRAP = "\x1b[?7l";
const ENABLE_AUTOWRAP = "\x1b[?7h";

/**
 * Adapt Ink's full-frame writes to row-level updates. The Ink UI owns layout,
 * input, and transcript; this adapter prevents full-screen clears while it
 * streams output in the alternate screen.
 *
 * Screen-state safety: rows are addressed with absolute cursor positioning
 * only inside the physical viewport (`target.rows`). A frame taller than the
 * terminal is kept in logical state but painted bottom-anchored, and painting
 * disables autowrap so an over-wide row (wide CJK/emoji at the last column)
 * can never spill onto the next physical line and desynchronize every row
 * below it. The old behavior — writing row N at `ESC[N;1H` even when N
 * exceeded the terminal height — collapsed onto the last line and left stale
 * text after scroll/resize.
 *
 * Inline mode (main screen buffer + native scrollback): the dynamic frame is
 * anchored at a tracked absolute row (`frameTopRow`) that only ever moves
 * DOWN, mirroring Ink's own log-update model — sealed transcript bursts are
 * written at the anchor via `emitStaticBurst` and advance it, frames paint
 * downward from the anchor, and content past the screen bottom scrolls
 * natively into scrollback (with a deficit scroll emitted before repainting an
 * overflowing frame). Static bursts are emitted by the App through
 * `emitStaticBurst` rather than detected from write shapes, because Ink's
 * log-update appends a trailing newline to every dynamic frame and would make
 * such classification ambiguous.
 */
/** Startup diagnostics: MINI_AGENT_BOOT_TRACE=1 logs anchor/geometry events. */
const BOOT_TRACE = process.env.MINI_AGENT_BOOT_TRACE === "1";


export class IncrementalTerminalRenderer {
  private previousLines: string[] | undefined;
  private forceRedrawOnNextFrame = false;
  private lastTerminalRows = 0;
  /** Inline mode: absolute 1-based screen row of the dynamic frame's top line. */
  private frameTopRow: number | undefined;
  /** Inline mode: screen row of the last static burst's final line (undefined once scrolled off). */
  private lastBurstBottomRow: number | undefined;
  /**
   * Bottom rows of the dynamic frame that are pinned chrome (input box,
   * status bar, active cards), reported by the app via `setPinnedRows`.
   * A safe static burst must not overwrite those rows, and the post-burst
   * repaint diffs them instead of re-emitting them — that is what keeps the
   * input box from flickering while streaming lines commit one by one.
   */
  private pinnedRows = 0;
  /**
   * Set when a safe (no-erase) burst lands: the burst overwrote the frame's
   * top CONTENT rows in place and everything below — including the pinned
   * chrome — is physically untouched. The next frame repaints the content
   * rows (they shifted down with the burst) and diffs the pinned chrome.
   * Cleared once a paint consumes it.
   */
  private burstRepaintPending = false;
  /** Anchor used by the last painted frame; keeps burst-shifted bookkeeping exact. */
  private lastPaintAnchor: number | undefined;
  /** Anchor-to-main-screen pipeline flag: true for inline AND document layouts. */
  private readonly inline: boolean;

  constructor(
    private readonly target: WriteStream,
    options: { mode?: TuiLayoutMode } = {},
  ) {
    this.inline = options.mode === "inline" || options.mode === "document";
  }

  write(data: string): boolean {
    const forceRedraw = this.forceRedrawOnNextFrame || data.includes(ANSI_CLEAR_TERMINAL);
    const frame = extractInkFrame(data);
    if (frame === undefined) {
      this.target.write(data);
      return true;
    }

    const nextLines = frame.split("\n");
    if (nextLines.at(-1) === "") nextLines.pop();
    this.renderRows(nextLines, forceRedraw);
    this.forceRedrawOnNextFrame = false;
    return true;
  }

  /**
   * Emit a sealed-transcript burst onto the main screen above the dynamic
   * frame (inline layout mode).
   *
   * Called directly by the App (bypassing Ink's write pipeline) when the seal
   * boundary advances, so the write shape is unambiguous — Ink's log-update
   * appends a trailing newline to every dynamic frame, which makes write-shape
   * classification unreliable.
   *
   * With a known anchor: erase the previous frame region, print the burst at
   * the anchor, and advance the anchor past the emitted lines. The next Ink
   * frame repaints the dynamic frame below the burst. Repainting the saved
   * frame here would freeze the pre-burst composer into native scrollback
   * whenever the required deficit scroll runs before React commits the new
   * frame.
   * With an unknown anchor (burst before the first frame, e.g. a resumed
   * session): scroll once at the bottom row, print the burst so it flows into
   * scrollback, then blank the screen — the first frame re-anchors bottom on a
   * clean screen with zero overlap risk.
   */
  /**
   * Normalize a burst payload so the anchor math stays exact:
   * every line is clamped to the physical column budget so no line can
   * autowrap into extra physical rows, and the result always ends with a
   * newline so the cursor lands past the last emitted row. Without this, an
   * over-wide line (unwrapped code/table projection) wraps and the dynamic
   * frame paints over the burst's tail — the "new answer covers the
   * previous reply" overwrite.
   */
  private normalizeBurst(text: string, columns: number): string {
    const lines = (text.endsWith("\n") ? text : `${text}\n`).slice(0, -1).split("\n");
    return `${lines.map((line) => safeRowText(line, columns)).join("\n")}\n`;
  }

  emitStaticBurst(text: string): void {
    const startedAt = performance.now();
    const rows = Math.max(1, this.target.rows ?? 24);
    const columns = Math.max(1, this.target.columns ?? 80);
    const previous = this.previousLines ?? [];
    let paintedRows = 0;

    if (this.frameTopRow !== undefined) {
      const anchor = this.frameTopRow;
      const previousVisible = previous.length - Math.max(0, previous.length - rows);
      const burst = this.normalizeBurst(text, columns);
      const emittedLines = burst.length === 1 ? 0 : burst.slice(0, -1).split("\n").length;
      const pinned = Math.min(this.pinnedRows, previousVisible);
      // A SAFE burst lands entirely inside the frame's content rows: it
      // overwrites exactly the committed live-tail rows the frame sheds on
      // its next paint, and it never reaches the pinned chrome (input box,
      // status bar) or the bottom row. Everything below the burst stays
      // physically untouched, so no row is ever blanked mid-stream. The next
      // frame repaints the shifted content rows and diffs the pinned chrome,
      // which is what keeps the input box from flickering while LLM lines
      // commit one by one. (The legacy blank-then-deferred-full-repaint used
      // to erase the composer on every single commit.)
      const safe =
        emittedLines > 0 &&
        emittedLines <= Math.max(0, previousVisible - pinned) &&
        anchor + emittedLines - 1 <= rows;

      if (safe) {
        // Autowrap stays disabled around the burst so even a residual
        // over-wide line cannot wrap and desynchronize the anchor below it.
        this.target.write(`${DISABLE_AUTOWRAP}\x1b[${anchor};1H${burst}${ENABLE_AUTOWRAP}`);
        this.frameTopRow = Math.min(rows, anchor + emittedLines);
        this.lastBurstBottomRow = anchor + emittedLines - 1;
        // The diff baseline (previousLines) survives: unchanged pinned
        // chrome rows emit zero bytes on the next frame instead of being
        // erased and re-emitted — the visible part of the old flicker.
        this.burstRepaintPending = true;
        bootProbe(`burst lines=${emittedLines} anchor=${anchor} -> top=${this.frameTopRow} rows=${rows} no-erase\n`);
      } else {
        // Large burst (a whole message sealed at once): it would overwrite
        // the pinned chrome or run past the bottom row, so keep the legacy
        // blank + forced full repaint. One visible jump at a message
        // boundary is acceptable; per-line streaming commits never get here.
        let erase = "";
        for (let physical = anchor; physical <= Math.min(rows, anchor + previousVisible - 1); physical++) {
          erase += `\x1b[${physical};1H${ANSI_ERASE_LINE}`;
        }
        if (erase) this.target.write(erase);
        this.target.write(`${DISABLE_AUTOWRAP}\x1b[${anchor};1H${burst}${ENABLE_AUTOWRAP}`);
        this.frameTopRow = Math.min(rows, anchor + Math.max(0, emittedLines));
        this.lastBurstBottomRow = emittedLines > 0 ? anchor + emittedLines - 1 : undefined;
        bootProbe(`burst lines=${emittedLines} anchor=${anchor} -> top=${this.frameTopRow} rows=${rows} erased\n`);
        // Force the next Ink frame to repaint against an empty baseline. Ink
        // may consider its output unchanged, but its renderer still receives
        // the frame after the state change that emitted this burst.
        this.previousLines = [];
        this.forceRedrawOnNextFrame = true;
      }
    } else {
      // Anchor unknown: start at the bottom row, let the burst scroll, then
      // clear the screen so the first frame anchors on a clean surface.
      this.target.write(`\x1b[${rows};1H\n${this.normalizeBurst(text, columns)}`);
      this.target.write(`\x1b[${rows};1H${"\n".repeat(rows)}`);
      this.previousLines = [];
      this.lastBurstBottomRow = undefined;
    }

    recordFramePaint(performance.now() - startedAt, paintedRows);
  }

  /** Legacy RenderLine entry point retained for shared projections/tests. */
  renderLines(lines: readonly RenderLine[]): void {
    this.renderRows(lines.map((line) => formatRenderLine(line)));
  }

  /** Format terminal rows before updating only the cells changed by Ink. */
  renderRows(nextLines: readonly string[], forceRedraw = false): void {
    const startedAt = performance.now();
    const previous = this.previousLines ?? [];
    const columns = Math.max(1, this.target.columns ?? 80);
    const rows = Math.max(1, this.target.rows ?? 24);
    if (BOOT_TRACE) {
      process.stderr.write(`\n[boot-trace] paint rows=${rows} cols=${columns} lines=${nextLines.length} mode=${this.inline ? "flow" : "alt"}\n`);
    }
    if (rows !== this.lastTerminalRows) {
      // Terminal resized: every cached row is physically stale (reflowed or
      // scrolled into scrollback), so repaint the whole visible frame. In
      // inline mode the anchor is re-derived on the next paint because the
      // reflow invalidated absolute row positions.
      this.lastTerminalRows = rows;
      forceRedraw = true;
      if (this.inline) this.frameTopRow = undefined;
      // Geometry is stale: drop pending burst bookkeeping so the re-anchor
      // below starts from a clean baseline.
      this.burstRepaintPending = false;
      this.lastPaintAnchor = undefined;
    }

    let paintedRows = 0;
    let output = "";
    if (this.inline) {
      output = this.renderRowsInline(nextLines, previous, { rows, columns, forceRedraw }, () => {
        paintedRows += 1;
      });
    } else {
      paintedRows = this.renderRowsAlternate(nextLines, previous, { rows, columns, forceRedraw });
    }

    this.previousLines = [...nextLines];
    recordFramePaint(performance.now() - startedAt, paintedRows);
  }

  /** Alternate-screen paint: top-anchored absolute rows, unchanged behavior. */
  private renderRowsAlternate(
    nextLines: readonly string[],
    previous: readonly string[],
    view: { rows: number; columns: number; forceRedraw: boolean },
  ): number {
    const { rows, columns, forceRedraw } = view;
    // Rows beyond the physical viewport cannot be addressed; keep them in
    // logical state (Ink still diffs against them) but never paint them.
    const paintFrom = Math.max(0, nextLines.length - rows);
    let output = "";
    let paintedRows = 0;
    for (let index = 0; index < nextLines.length; index++) {
      if (!forceRedraw && nextLines[index] === previous[index]) continue;
      if (index < paintFrom) continue;
      const physical = index - paintFrom + 1;
      if (physical > rows) continue;
      const text = safeRowText(nextLines[index] ?? "", columns);
      output += `\x1b[${physical};1H${ANSI_ERASE_LINE}${text}`;
      paintedRows += 1;
      // Forced full repaints (resize, static-burst repaints) are legitimate;
      // only organic repaints feed the flicker detector.
      if (!forceRedraw) recordRowRepaint(physical);
    }
    // Clear physical rows the previous frame occupied but the next one does
    // not (shorter frame after resize/clip).
    const previousPaintEnd = Math.min(rows, previous.length - Math.max(0, previous.length - rows));
    const nextPaintEnd = Math.min(rows, nextLines.length - paintFrom);
    for (let physical = nextPaintEnd + 1; physical <= previousPaintEnd; physical++) {
      output += `\x1b[${physical};1H${ANSI_ERASE_LINE}`;
    }

    if (output) {
      // Park the cursor on the last painted row. Autowrap stays disabled only
      // around the paint burst: writing at the final column of the final row
      // must not scroll the terminal.
      const parkRow = Math.min(rows, Math.max(1, nextPaintEnd));
      output = `${DISABLE_AUTOWRAP}${output}\x1b[${parkRow};1H${ENABLE_AUTOWRAP}`;
      this.target.write(output);
    }
    return paintedRows;
  }

  /**
   * Inline-mode paint: the frame occupies `frameTopRow .. frameTopRow + H - 1`
   * on the main screen. The anchor only moves down (static bursts and deficit
   * scrolls); content pushed past the bottom row lands in native scrollback.
   * Returns the paint burst ("" when nothing changed).
   */
  private renderRowsInline(
    nextLines: readonly string[],
    previous: readonly string[],
    view: { rows: number; columns: number; forceRedraw: boolean },
    onPaint: () => void,
  ): string {
    const { rows, columns } = view;
    let forceRedraw = view.forceRedraw;
    const paintFrom = Math.max(0, nextLines.length - rows);
    const visibleHeight = nextLines.length - paintFrom;

    if (this.frameTopRow === undefined) {
      // First paint (or post-resize): anchor the frame's last line at the
      // screen bottom. Rows above stay untouched, so shell echo / scrollback
      // survive; the approximation only ever overwrites rows at or below the
      // cursor's last known position.
      this.frameTopRow = Math.max(1, rows - visibleHeight + 1);
      // After a resize the reflowed bottom window may sit inside the last
      // emitted burst; never start above the burst's bottom row, or the frame
      // would paint over sealed transcript rows. Pushing the anchor down
      // hands the overlap to the deficit scroll below, which carries the
      // burst into native scrollback instead.
      if (this.lastBurstBottomRow !== undefined && this.lastBurstBottomRow + 1 > this.frameTopRow) {
        this.frameTopRow = this.lastBurstBottomRow + 1;
      }
      bootProbe(`anchor-init top=${this.frameTopRow} visible=${visibleHeight} rows=${rows}\n`);
    }
    // The frame must fit between its anchor and the screen bottom. Whatever
    // overflows scrolls natively: emit the deficit at the bottom row first,
    // which pushes the preceding screen content (previous static bursts
    // included) into scrollback, then repaint against the shifted anchor.
    const overflow = this.frameTopRow + visibleHeight - 1 - rows;
    if (overflow > 0) {
      bootProbe(`anchor-scroll overflow=${overflow} top=${this.frameTopRow} visible=${visibleHeight}\n`);
      this.target.write(`\x1b[${rows};1H${"\n".repeat(overflow)}`);
      this.frameTopRow -= overflow;
      if (this.lastBurstBottomRow !== undefined) {
        // The scroll shifts the burst content up too; drop the marker once
        // it leaves the visible screen.
        const shifted = this.lastBurstBottomRow - overflow;
        this.lastBurstBottomRow = shifted > 0 ? shifted : undefined;
      }
      // The deficit scroll physically moved the pinned chrome up, so it must
      // be repainted at its new bottom rows. The scroll and the repaint below
      // are one terminal write, so the move stays invisible (no flicker).
      forceRedraw = true;
    }

    // A safe burst overwrote the frame's top content rows in place; the
    // pinned chrome below it never moved. Repaint the shifted content rows,
    // but DIFF the pinned rows so an unchanged input box emits zero bytes
    // instead of being erased and re-emitted (the input-box flicker).
    const pinnedStart = !forceRedraw && this.burstRepaintPending
      ? nextLines.length - Math.min(this.pinnedRows, nextLines.length)
      : -1;

    let output = "";
    for (let index = 0; index < nextLines.length; index++) {
      const pinnedRow = index >= pinnedStart;
      if (!forceRedraw && pinnedRow && nextLines[index] === previous[index]) continue;
      if (index < paintFrom) continue;
      const physical = this.frameTopRow + index - paintFrom;
      if (physical > rows) continue;
      const text = safeRowText(nextLines[index] ?? "", columns);
      output += `\x1b[${physical};1H${ANSI_ERASE_LINE}${text}`;
      onPaint();
      // Burst-shift rewrites of content rows and forced repaints are
      // legitimate; only organic pinned-row repaints feed the flicker detector.
      if (!forceRedraw && pinnedStart >= 0 && pinnedRow) recordRowRepaint(physical);
    }
    // Clear physical rows the previous frame occupied but the next one does
    // not (shorter frame while pinned to the same anchor). Rows at or above
    // the new frame top may hold a just-landed burst — never erase them.
    const previousAnchor = this.lastPaintAnchor ?? this.frameTopRow;
    const previousPaintEnd = previousAnchor + (previous.length - Math.max(0, previous.length - rows)) - 1;
    const nextPaintEnd = this.frameTopRow + visibleHeight - 1;
    for (let physical = Math.max(nextPaintEnd + 1, this.frameTopRow); physical <= Math.min(rows, previousPaintEnd); physical++) {
      output += `\x1b[${physical};1H${ANSI_ERASE_LINE}`;
    }

    if (output) {
      const parkRow = Math.min(rows, Math.max(1, nextPaintEnd));
      output = `${DISABLE_AUTOWRAP}${output}\x1b[${parkRow};1H${ENABLE_AUTOWRAP}`;
      this.target.write(output);
    }
    this.lastPaintAnchor = this.frameTopRow;
    this.burstRepaintPending = false;
    return output;
  }

  /**
   * Clear the visible screen while keeping the terminal's scrollback intact,
   * then repaint the current dynamic frame. Mirrors the `Ctrl+L` behavior of
   * terminal-first agents: the sealed transcript above stays reachable in the
   * native scrollback, and the frame re-anchors fresh.
   *
   * The repaint is driven from the saved frame content because Ink skips
   * writes for unchanged output — after a screen clear there is nothing on
   * screen to diff against, so the renderer must restore its own baseline.
   */
  clearScreen(): void {
    const previous = this.previousLines ? [...this.previousLines] : [];
    this.target.write(`${ANSI_CLEAR_TERMINAL}\x1b[H`);
    this.previousLines = undefined;
    this.frameTopRow = undefined;
    this.lastBurstBottomRow = undefined;
    this.lastPaintAnchor = undefined;
    this.burstRepaintPending = false;
    this.lastTerminalRows = 0;
    this.forceRedrawOnNextFrame = false;
    if (previous.length > 0) this.renderRows(previous, true);
  }

  reset(): void {
    this.previousLines = undefined;
    this.forceRedrawOnNextFrame = false;
    this.lastTerminalRows = 0;
    this.frameTopRow = undefined;
    this.lastBurstBottomRow = undefined;
    this.lastPaintAnchor = undefined;
    this.burstRepaintPending = false;
  }

  /**
   * Pre-first-paint anchor from a DSR cursor query (flow layouts only).
   * Without this, the first paint bottom-anchors the frame, leaving the whole
   * gap between the shell prompt and the screen bottom visually empty.
   */
  setInitialAnchor(row: number): void {
    if (!this.inline || this.previousLines !== undefined || this.frameTopRow !== undefined) return;
    const rows = Math.max(1, this.target.rows ?? 24);
    // Pre-set the geometry baseline: the first paint would otherwise read
    // lastTerminalRows=0 → "rows changed" → and wipe this anchor.
    this.lastTerminalRows = rows;
    this.frameTopRow = Math.min(rows, Math.max(1, Math.floor(row)));
    bootProbe(`anchor-prime row=${this.frameTopRow}`);
  }

  /**
   * Report how many bottom rows of the dynamic frame are pinned chrome
   * (input box, status bar, active cards). Flow layouts only: safe static
   * bursts stop short of those rows and post-burst repaints diff them, so
   * the input box is never blanked while the LLM streams.
   */
  setPinnedRows(rows: number): void {
    this.pinnedRows = Math.max(0, Math.floor(rows) || 0);
  }

  invalidate(): void {
    this.forceRedrawOnNextFrame = true;
  }
}

/**
 * Clamp a row to the physical column budget, keeping ANSI styling intact.
 *
 * ESC (U+001B) is the first byte of every SGR sequence Ink emits, so a blanket
 * control-character strip turns `ESC[38;5;231m` into literal `[38;5;231m`
 * text and the UI paints as garbage. Only SGR styling (and OSC strings) is
 * preserved: any other escape — cursor moves, mouse reports such as
 * `ESC[<64;1;1M` — would corrupt the row grid, so it is dropped along with
 * every remaining control character.
 */
const ANSI_STYLE_OR_CONTROL = /\x1b\[[0-9;:]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\u0000-\u001f\u007f]/g;

function safeRowText(text: string, columns: number): string {
  const cleaned = text.replace(ANSI_STYLE_OR_CONTROL, (match) =>
    match.length > 1 && match.charCodeAt(0) === 0x1b ? match : "",
  );
  return truncateTerminalText(cleaned, columns);
}

/** Create a stdout-compatible facade without mutating process.stdout. */
export function createIncrementalStdout(stdout: WriteStream, options: { mode?: TuiLayoutMode } = {}): WriteStream {
  return createIncrementalStdoutHandle(stdout, options).facade;
}

/**
 * Facade + renderer pair. The facade installs as Ink's stdout; the renderer
 * handle is exposed so the App can emit sealed-transcript bursts
 * (`emitStaticBurst`) directly, bypassing Ink's frame pipeline.
 */
export function createIncrementalStdoutHandle(
  stdout: WriteStream,
  options: { mode?: TuiLayoutMode } = {},
): { facade: WriteStream; renderer: IncrementalTerminalRenderer } {
  const renderer = new IncrementalTerminalRenderer(stdout, options);
  stdout.on("resize", () => renderer.invalidate());
  // A proxy keeps rows/columns, isTTY, resize listeners, and stream internals
  // from the real WriteStream. Object.create(stdout) loses own properties such
  // as `rows`, which makes Ink believe the terminal has zero height.
  const facade = new Proxy(stdout, {
    get(target, property, receiver) {
      if (property === "write") {
        return ((chunk: string | Uint8Array, ...args: unknown[]) => {
          if (typeof chunk !== "string" || args.length > 0) {
            return target.write(chunk as string, ...(args as []));
          }
          renderer.write(chunk);
          return true;
        }) as WriteStream["write"];
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { facade, renderer };
}

function extractInkFrame(data: string): string | undefined {
  if (data.includes(ANSI_CLEAR_TERMINAL)) {
    const home = data.lastIndexOf("\x1b[H");
    return home >= 0 ? data.slice(home + 3) : data.slice(data.indexOf(ANSI_CLEAR_TERMINAL) + ANSI_CLEAR_TERMINAL.length);
  }
  // log-update.eraseLines() writes one `ESC[2K`/`ESC[<n>A` pair per line and
  // ends with `ESC[G`; remove the whole cursor/erase prefix rather than
  // treating that cursor command as visible frame text.
  // Only a leading erase sequence counts: a later `ESC[G` inside the frame is
  // row content (cursor styling Ink left in place), not the redraw header.
  const erasePrefix = /^(?:\x1b\[[0-9]*[AB]|\x1b\[2K)*\x1b\[G/.exec(data);
  if (erasePrefix) return data.slice(erasePrefix[0].length);
  if (!data.includes("\n")) return undefined;
  // The initial Ink frame has no erase prefix. The proxy is only installed
  // as Ink's stdout, so a newline-bearing write is a frame in this path.
  return data;
}
