import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";
import type { RenderLine } from "./render-lines.ts";
import { formatRenderLine } from "./render-line-format.ts";
import { isSgrMouseEvent, parseSgrMouseWheel } from "./mouse-events.ts";

export type PiTuiFrameBuilder = (width: number, height: number) => readonly RenderLine[];

/**
 * Bridges the existing presentation model to pi-tui's physical-row component
 * contract. pi-tui owns the viewport and redraw policy; the application still
 * owns state, input actions, and message projection.
 */
export class PiTuiFrame implements Component {
  constructor(
    private readonly terminal: Pick<Terminal, "rows">,
    private readonly buildFrame: PiTuiFrameBuilder,
    private readonly onInput: (data: string) => void,
  ) {}

  render(width: number): string[] {
    const height = Math.max(1, this.terminal.rows || 24);
    return this.buildFrame(width, height).map((line) => {
      const formatted = formatRenderLine(line);
      return visibleWidth(formatted) > width
        ? truncateToWidth(formatted, width, "")
        : formatted;
    });
  }

  handleInput(data: string): void {
    // SGR wheel events are consumed by TerminalInputController and become
    // transcript scroll actions. Ignore only legacy/SGR button events so
    // mouse selection does not leak escape bytes into the prompt.
    if (isSgrMouseEvent(data) && !parseSgrMouseWheel(data)) return;
    if (data.startsWith("\x1b[M")) return;
    this.onInput(data);
  }

  invalidate(): void {
    // The frame is built from current application state on every render.
  }
}
